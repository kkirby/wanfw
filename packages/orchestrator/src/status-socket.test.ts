import { describe, expect, it, afterEach } from "vitest";
import { request } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
  const bundlesDir = await mkdtemp(join(tmpdir(), "wanfw-status-bundles-"));
  const statusDir = await mkdtemp(join(tmpdir(), "wanfw-status-statusdir-"));
  const secretsDir = await mkdtemp(join(tmpdir(), "wanfw-status-secretsdir-"));
  return {
    router: buildStatusSocketRouter(heartbeat, nudge, { store, stagingDir, statusDir, secretsDir }),
    heartbeat,
    nudge,
    store,
    dbDir,
    stagingDir,
    bundlesDir,
    statusDir,
    secretsDir,
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
    const { router, heartbeat, nudge, store, dbDir, stagingDir, bundlesDir, statusDir, secretsDir } = await freshRouter();
    dirs.push(dbDir, stagingDir, bundlesDir, statusDir, secretsDir);
    const dir = await mkdtemp(join(tmpdir(), "wanfw-status-socket-"));
    dirs.push(dir);
    const socketPath = join(dir, "orch-status.sock");
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));
    return { socketPath, heartbeat, nudge, store, stagingDir, bundlesDir, statusDir, secretsDir };
  }

  it("GET /status returns the current heartbeat", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "GET", "/status");
    expect(res.status).toBe(200);
    expect((res.body as { phase: string }).phase).toBe("pending-init");
  });

  it("GET /schema returns 404 when no composed schema has been published yet", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "GET", "/schema");
    expect(res.status).toBe(404);
  });

  it("GET /schema returns the published composed schema (T3.2)", async () => {
    const { socketPath, statusDir, store, bundlesDir } = await boot();
    const { publishComposedSchema } = await import("./composed-schema/index.js");
    await publishComposedSchema(store, bundlesDir, statusDir);

    const res = await requestOverSocket(socketPath, "GET", "/schema");
    expect(res.status).toBe(200);
    expect((res.body as { envelope: unknown }).envelope).toBeDefined();
  });

  it("POST /validate validates a draft against the published composed schema", async () => {
    const { socketPath, statusDir, store, bundlesDir } = await boot();
    const { publishComposedSchema } = await import("./composed-schema/index.js");
    await publishComposedSchema(store, bundlesDir, statusDir);

    const res = await requestOverSocket(socketPath, "POST", "/validate", {
      schemaVersion: 1,
      kind: "Service",
      metadata: { id: "jellyfin" },
      spec: {
        deploy: { plugin: "deploy-docker" },
        expose: { hostname: "jellyfin", backendPort: 8096, backendProtocol: "http" },
      },
    });
    expect(res.status).toBe(200);
    expect((res.body as { valid: boolean }).valid).toBe(true);
  });

  it("GET /approvals/pending returns an empty list until T3.7", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "GET", "/approvals/pending");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: [] });
  });

  it("POST /validate returns 503 with no published schema yet, and never mutates heartbeat state (pure function contract, §5.5)", async () => {
    const { socketPath, heartbeat } = await boot();
    const before = JSON.stringify(heartbeat.current);
    const res = await requestOverSocket(socketPath, "POST", "/validate", { schemaVersion: 1 });
    expect(res.status).toBe(503);
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

  it("GET /status/services/:id returns 404 when no status doc has been published for that service", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "GET", "/status/services/jellyfin");
    expect(res.status).toBe(404);
  });

  it("GET /status/services/:id returns OBSERVE's published status doc (T3.9)", async () => {
    const { socketPath, statusDir } = await boot();
    await mkdir(join(statusDir, "services"), { recursive: true });
    await writeFile(join(statusDir, "services", "jellyfin.json"), JSON.stringify({ serviceId: "jellyfin", phase: "live", endpoints: [] }));

    const res = await requestOverSocket(socketPath, "GET", "/status/services/jellyfin");
    expect(res.status).toBe(200);
    expect((res.body as { phase: string }).phase).toBe("live");
  });

  it("GET /status/services lists every published status doc (tier1's dashboard read path)", async () => {
    const { socketPath, statusDir } = await boot();
    await mkdir(join(statusDir, "services"), { recursive: true });
    await writeFile(join(statusDir, "services", "jellyfin.json"), JSON.stringify({ serviceId: "jellyfin", phase: "live" }));
    await writeFile(join(statusDir, "services", "kavita.json"), JSON.stringify({ serviceId: "kavita", phase: "reconciling" }));

    const res = await requestOverSocket(socketPath, "GET", "/status/services");
    expect(res.status).toBe(200);
    const services = (res.body as { services: Array<{ serviceId: string }> }).services;
    expect(services.map((s) => s.serviceId).sort()).toEqual(["jellyfin", "kavita"]);
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

  it("GET /secrets mirrors the admin socket's secret store read-only (names + lastRotated, never values -- T4.1, tier1's read path)", async () => {
    const { socketPath, secretsDir } = await boot();
    await mkdir(join(secretsDir, "cert-letsencrypt-dns01"), { recursive: true, mode: 0o700 });
    await writeFile(join(secretsDir, "cert-letsencrypt-dns01", "acme-account-key"), "the-actual-secret-value", { mode: 0o600 });

    const res = await requestOverSocket(socketPath, "GET", "/secrets");
    expect(res.status).toBe(200);
    const secrets = (res.body as { secrets: Array<{ name: string; lastRotated: string }> }).secrets;
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.name).toBe("cert-letsencrypt-dns01/acme-account-key");
    expect(JSON.stringify(res.body)).not.toContain("the-actual-secret-value");
  });

  it("GET /framework mirrors the admin socket's framework doc, null before anything is set (T5.3)", async () => {
    const { socketPath, store } = await boot();
    const before = await requestOverSocket(socketPath, "GET", "/framework");
    expect(before.body).toEqual({ framework: null });

    const doc = {
      schemaVersion: 1,
      kind: "Framework",
      metadata: { id: "framework" },
      spec: { domain: "example.tld", deploymentMode: "subdomain", acmeEmail: "ops@example.tld", roles: {} },
    };
    store.setFrameworkDoc(doc);
    const after = await requestOverSocket(socketPath, "GET", "/framework");
    expect(after.body).toEqual({ framework: doc });
  });

  it("GET /operator-info mirrors the admin socket's operator info, null before anything is set (T5.5)", async () => {
    const { socketPath, store } = await boot();
    const before = await requestOverSocket(socketPath, "GET", "/operator-info");
    expect(before.body).toEqual({ operatorInfo: null });

    const info = { domain: "example.tld", wanIp: "203.0.113.5", networkProvider: "network-bridge", instructions: ["forward WAN:443 -> LAN IP"] };
    store.setOperatorInfo(info);
    const after = await requestOverSocket(socketPath, "GET", "/operator-info");
    expect(after.body).toEqual({ operatorInfo: info });
  });
});
