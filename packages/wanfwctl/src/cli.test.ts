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

  async function bootKeyRouter() {
    const router = new JsonUdsRouter();
    let publicKeyPem = "PUBKEY-v1";
    router.register("GET", "/key", async () => ({ status: 200, body: { publicKeyPem } }));
    router.register("POST", "/key/rotate", async () => {
      publicKeyPem = "PUBKEY-v2";
      return { status: 200, body: { publicKeyPem } };
    });
    router.register("POST", "/key/import", async ({ body }) => {
      const { privateKeyPem } = body as { privateKeyPem?: string };
      if (!privateKeyPem) return { status: 400, body: { error: "usage" } };
      publicKeyPem = "PUBKEY-IMPORTED";
      return { status: 200, body: { publicKeyPem } };
    });
    const dir = await mkdtemp(join(tmpdir(), "wanfw-cli-key-"));
    dirs.push(dir);
    const socketPath = join(dir, "admin.sock");
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));
    return socketPath;
  }

  it("key show: prints the current public key", async () => {
    const socketPath = await bootKeyRouter();
    const out = captureOutput();
    const code = await runCli(["key", "show"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(out.lines.join("")).toBe("PUBKEY-v1");
  });

  it("key rotate: prints the new public key", async () => {
    const socketPath = await bootKeyRouter();
    const out = captureOutput();
    const code = await runCli(["key", "rotate"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(out.lines.join("")).toMatch(/PUBKEY-v2/);
  });

  it("key import: reads PEM from stdin, never argv", async () => {
    const socketPath = await bootKeyRouter();
    const out = captureOutput();
    const code = await runCli(["key", "import"], {
      adminSocketPath: socketPath,
      ...out,
      readStdin: async () => "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
    });
    expect(code).toBe(EXIT_CODES.ok);
    expect(out.lines.join("")).toMatch(/PUBKEY-IMPORTED/);
  });

  it("key import: exits usage when stdin is empty", async () => {
    const socketPath = await bootKeyRouter();
    const out = captureOutput();
    const code = await runCli(["key", "import"], {
      adminSocketPath: socketPath,
      ...out,
      readStdin: async () => "",
    });
    expect(code).toBe(EXIT_CODES.usage);
  });
});
