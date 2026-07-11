import { describe, expect, it, afterEach } from "vitest";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { JsonUdsRouter, listenOnUnixSocket } from "./uds-server.js";

function requestOverSocket(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("JsonUdsRouter", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function socketInTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-uds-"));
    dirs.push(dir);
    return join(dir, "test.sock");
  }

  it("dispatches a registered GET route", async () => {
    const router = new JsonUdsRouter();
    router.register("GET", "/status", async () => ({ status: 200, body: { ok: true } }));
    const socketPath = await socketInTempDir();
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));

    const res = await requestOverSocket(socketPath, "GET", "/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 404 for an unregistered route", async () => {
    const router = new JsonUdsRouter();
    const socketPath = await socketInTempDir();
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));

    const res = await requestOverSocket(socketPath, "GET", "/nope");
    expect(res.status).toBe(404);
  });

  it("extracts named path params", async () => {
    const router = new JsonUdsRouter();
    router.register("GET", "/status/services/:id", async ({ params }) => ({
      status: 200,
      body: { id: params.id },
    }));
    const socketPath = await socketInTempDir();
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));

    const res = await requestOverSocket(socketPath, "GET", "/status/services/jellyfin");
    expect(res.body).toEqual({ id: "jellyfin" });
  });

  it("parses a JSON POST body and passes it to the handler", async () => {
    const router = new JsonUdsRouter();
    router.register("POST", "/echo", async ({ body }) => ({ status: 200, body }));
    const socketPath = await socketInTempDir();
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));

    const res = await requestOverSocket(socketPath, "POST", "/echo", { hello: "world" });
    expect(res.body).toEqual({ hello: "world" });
  });

  it("unlinks a stale socket file before listening again", async () => {
    const router = new JsonUdsRouter();
    router.register("GET", "/status", async () => ({ status: 200, body: {} }));
    const socketPath = await socketInTempDir();
    const first = listenOnUnixSocket(router, socketPath);
    await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((r) => first.close(() => r()));

    // Socket file still exists on disk after close(); relisten must unlink it.
    const second = listenOnUnixSocket(router, socketPath);
    servers.push(second);
    await new Promise((r) => setTimeout(r, 50));
    const res = await requestOverSocket(socketPath, "GET", "/status");
    expect(res.status).toBe(200);
  });

  it("listRoutes reflects exactly what was registered", () => {
    const router = new JsonUdsRouter();
    router.register("get", "/a", async () => ({ status: 200, body: {} }));
    router.register("POST", "/b", async () => ({ status: 200, body: {} }));
    expect(router.listRoutes()).toEqual([
      { method: "GET", path: "/a" },
      { method: "POST", path: "/b" },
    ]);
  });
});
