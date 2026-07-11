import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { listenOnUnixSocket, JsonUdsRouter } from "@wanfw/orchestrator";
import { runCli } from "./cli.js";
import { EXIT_CODES } from "./exit-codes.js";

function captureOutput() {
  const lines: string[] = [];
  const errLines: string[] = [];
  return {
    stdout: (line: string) => lines.push(line),
    stderr: (line: string) => errLines.push(line),
    lines,
    errLines,
  };
}

describe("wanfwctl-inner CLI", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function bootAdminSocket(status: unknown = { phase: "pending-init", ts: "x", version: "0.1.0" }) {
    const router = new JsonUdsRouter();
    router.register("GET", "/status", async () => ({ status: 200, body: status }));
    const dir = await mkdtemp(join(tmpdir(), "wanfw-cli-"));
    dirs.push(dir);
    const socketPath = join(dir, "admin.sock");
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));
    return socketPath;
  }

  it("status: exits 0 and prints the heartbeat JSON when the socket is reachable", async () => {
    const socketPath = await bootAdminSocket({ phase: "live", ts: "2026-01-01T00:00:00Z", version: "0.1.0" });
    const out = captureOutput();
    const code = await runCli(["status"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(out.lines.join(""))).toEqual({ phase: "live", ts: "2026-01-01T00:00:00Z", version: "0.1.0" });
  });

  it("status: exits 7 (daemonUnreachable) when the admin socket does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-cli-"));
    dirs.push(dir);
    const missingSocket = join(dir, "does-not-exist.sock");
    const out = captureOutput();
    const code = await runCli(["status"], { adminSocketPath: missingSocket, ...out });
    expect(code).toBe(EXIT_CODES.daemonUnreachable);
    expect(out.errLines.join("")).toMatch(/unreachable/);
  });

  it("exits 2 (usage) for an unknown command", async () => {
    const socketPath = await bootAdminSocket();
    const out = captureOutput();
    const code = await runCli(["not-a-real-command"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.usage);
  });
});
