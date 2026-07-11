import { describe, expect, it, afterEach } from "vitest";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { listenOnUnixSocket } from "./uds-server.js";
import { buildStatusSocketRouter, STATUS_SOCKET_ROUTE_ALLOWLIST, type NudgeState } from "./status-socket.js";
import type { HeartbeatState } from "./heartbeat.js";
import { StateStore } from "./state-store/store.js";

function requestOverSocket(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function freshRouter() {
  const heartbeat: HeartbeatState = { current: { phase: "pending-init", ts: "x", version: "0.1.0" } };
  const nudge: NudgeState = { nudgedAt: null, count: 0 };
  const dbDir = await mkdtemp(join(tmpdir(), "wanfw-status-router-"));
  const store = new StateStore(join(dbDir, "state.sqlite3"));
  const stagingDir = await mkdtemp(join(tmpdir(), "wanfw-status-staging-"));
  return {
    router: buildStatusSocketRouter(heartbeat, nudge, { store, stagingDir }),
    heartbeat,
    nudge,
    store,
    dbDir,
    stagingDir,
  };
}

describe("status socket route allowlist (invariant #4 enforcement -- keep this green forever)", () => {
  it("registers exactly the allowlisted routes, no more, no fewer", async () => {
    const { router } = await freshRouter();
    const actual = router.listRoutes();
    const expected = [...STATUS_SOCKET_ROUTE_ALLOWLIST];
    expect(actual).toEqual(expect.arrayContaining(expected));
    expect(actual.length).toBe(expected.length);
  });

  it("contains no mutating verbs beyond the explicitly allowed POST /validate and POST /nudge", () => {
    const mutatingLike = STATUS_SOCKET_ROUTE_ALLOWLIST.filter(
      (r) => r.method === "PUT" || r.method === "DELETE" || r.method === "PATCH",
    );
    expect(mutatingLike).toEqual([]);
  });
});

describe("status socket handlers (live HTTP over a real Unix socket)", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function boot() {
    const { router, heartbeat, nudge, store, dbDir, stagingDir } = await freshRouter();
    dirs.push(dbDir, stagingDir);
    const dir = await mkdtemp(join(tmpdir(), "wanfw-status-socket-"));
    dirs.push(dir);
    const socketPath = join(dir, "orch-status.sock");
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));
    return { socketPath, heartbeat, nudge, store, stagingDir };
  }

  it("GET /status returns the current heartbeat", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "GET", "/status");
    expect(res.status).toBe(200);
    expect((res.body as { phase: string }).phase).toBe("pending-init");
  });

  it("GET /schema returns 404 until T3.2 implements composed schema publishing", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "GET", "/schema");
    expect(res.status).toBe(404);
  });

  it("GET /approvals/pending returns an empty list until T3.7", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "GET", "/approvals/pending");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: [] });
  });

  it("POST /validate returns 501 and never mutates heartbeat state (pure function contract, §5.5)", async () => {
    const { socketPath, heartbeat } = await boot();
    const before = JSON.stringify(heartbeat.current);
    const res = await requestOverSocket(socketPath, "POST", "/validate", { schemaVersion: 1 });
    expect(res.status).toBe(501);
    expect(JSON.stringify(heartbeat.current)).toBe(before);
  });

  it("POST /nudge acknowledges and records the nudge (the socket's only allowed side effect)", async () => {
    const { socketPath, nudge } = await boot();
    expect(nudge.count).toBe(0);
    const res = await requestOverSocket(socketPath, "POST", "/nudge");
    expect(res.status).toBe(202);
    expect(nudge.count).toBe(1);
    expect(nudge.nudgedAt).not.toBeNull();
  });

  it("GET /status/services/:id returns 404 until the reconciler exists (T3.x)", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "GET", "/status/services/jellyfin");
    expect(res.status).toBe(404);
  });

  it("GET /plugins reflects live trust records (tier1's read path to trust data)", async () => {
    const { socketPath, store } = await boot();
    let res = await requestOverSocket(socketPath, "GET", "/plugins");
    expect(res.body).toEqual({ trusted: [] });

    store.insertTrustRecord({
      plugin_id: "deploy-docker",
      version: "0.1.0",
      sha256: "abc",
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });
    res = await requestOverSocket(socketPath, "GET", "/plugins");
    expect((res.body as { trusted: unknown[] }).trusted).toHaveLength(1);
  });

  it("GET /plugins?pending=true lists staged bundles", async () => {
    const { socketPath, stagingDir } = await boot();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(stagingDir, "b1", "dist"), { recursive: true });
    await writeFile(
      join(stagingDir, "b1", "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "b1",
        version: "0.1.0",
        frameworkApi: "^1.0",
        types: ["deploy"],
        entrypoint: "dist/main.js",
        runtime: "node22",
        capabilities: [],
      }),
    );
    const res = await requestOverSocket(socketPath, "GET", "/plugins?pending=true");
    expect((res.body as { staged: unknown[] }).staged).toHaveLength(1);
  });

  it("GET /plugins/:id returns 404 for an untrusted id, 200 with grants for a trusted one", async () => {
    const { socketPath, store } = await boot();
    const missing = await requestOverSocket(socketPath, "GET", "/plugins/nope");
    expect(missing.status).toBe(404);

    store.insertTrustRecord({
      plugin_id: "deploy-docker",
      version: "0.1.0",
      sha256: "abc",
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });
    const found = await requestOverSocket(socketPath, "GET", "/plugins/deploy-docker");
    expect(found.status).toBe(200);
  });
});
