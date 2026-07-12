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

  async function bootAuditRouter(verifyResult: object) {
    const router = new JsonUdsRouter();
    router.register("GET", "/audit", async () => ({
      status: 200,
      body: { entries: [{ seq: 1, type: "log.emit" }] },
    }));
    router.register("POST", "/audit/verify", async () => ({ status: 200, body: verifyResult }));
    const dir = await mkdtemp(join(tmpdir(), "wanfw-cli-audit-"));
    dirs.push(dir);
    const socketPath = join(dir, "admin.sock");
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));
    return socketPath;
  }

  it("audit tail: prints entries as JSON lines", async () => {
    const socketPath = await bootAuditRouter({ valid: true, entryCount: 1 });
    const out = captureOutput();
    const code = await runCli(["audit", "tail"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(out.lines[0]!)).toEqual({ seq: 1, type: "log.emit" });
  });

  it("audit tail --verify: exits 0 on a clean chain", async () => {
    const socketPath = await bootAuditRouter({ valid: true, entryCount: 5 });
    const out = captureOutput();
    const code = await runCli(["audit", "tail", "--verify"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(out.lines.join("")).toMatch(/5 entries, chain verified/);
  });

  it("audit tail --verify: exits refused and reports the failure when tampered", async () => {
    const socketPath = await bootAuditRouter({ valid: false, entryCount: 5, failedAtSeq: 3, reason: "hash mismatch" });
    const out = captureOutput();
    const code = await runCli(["audit", "tail", "--verify"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.refused);
    expect(out.errLines.join("")).toMatch(/TAMPER DETECTED at seq 3/);
  });

  async function bootPluginRouter() {
    const router = new JsonUdsRouter();
    let trustCalls = 0;
    router.register("GET", "/plugins", async () => ({ status: 200, body: { trusted: [] } }));
    router.register("GET", "/plugins/:id", async ({ params }) =>
      params.id === "deploy-docker"
        ? { status: 200, body: { trusted: [{ plugin_id: "deploy-docker" }], grants: [] } }
        : { status: 404, body: { error: "not_found" } },
    );
    router.register("POST", "/plugins/trust", async ({ body }) => {
      trustCalls++;
      const { id, sha256 } = body as { id: string; sha256: string };
      return { status: 200, body: { pluginId: id, version: "0.1.0", sha256, grantedCaps: ["docker.image.pull"] } };
    });
    router.register("POST", "/plugins/trust-builtins", async () => ({
      status: 200,
      body: { trusted: [{ pluginId: "deploy-docker" }] },
    }));
    router.register("POST", "/plugins/untrust", async ({ body }) => ({
      status: 200,
      body: { pluginId: (body as { id: string }).id, untrusted: true },
    }));
    const dir = await mkdtemp(join(tmpdir(), "wanfw-cli-plugin-"));
    dirs.push(dir);
    const socketPath = join(dir, "admin.sock");
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));
    return { socketPath, trustCallCount: () => trustCalls };
  }

  it("plugin list: prints trusted plugins", async () => {
    const { socketPath } = await bootPluginRouter();
    const out = captureOutput();
    const code = await runCli(["plugin", "list"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(out.lines.join(""))).toEqual({ trusted: [] });
  });

  it("plugin show: prints 404 body and internalError exit for an untrusted id", async () => {
    const { socketPath } = await bootPluginRouter();
    const out = captureOutput();
    const code = await runCli(["plugin", "show", "nope"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.internalError);
  });

  it("plugin trust without --yes does not call the admin socket (dry-run confirmation)", async () => {
    const { socketPath, trustCallCount } = await bootPluginRouter();
    const out = captureOutput();
    const code = await runCli(["plugin", "trust", "deploy-docker@abc123"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(trustCallCount()).toBe(0);
    expect(out.lines.join("")).toMatch(/Re-run with --yes/);
  });

  it("plugin trust --yes calls the admin socket and prints granted capabilities", async () => {
    const { socketPath, trustCallCount } = await bootPluginRouter();
    const out = captureOutput();
    const code = await runCli(["plugin", "trust", "deploy-docker@abc123", "--yes"], {
      adminSocketPath: socketPath,
      ...out,
    });
    expect(code).toBe(EXIT_CODES.ok);
    expect(trustCallCount()).toBe(1);
    expect(out.lines.join("")).toMatch(/trusted deploy-docker@abc123/);
  });

  it("plugin trust: usage error when idAtHash is missing the @ separator", async () => {
    const { socketPath } = await bootPluginRouter();
    const out = captureOutput();
    const code = await runCli(["plugin", "trust", "deploy-docker", "--yes"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.usage);
  });

  it("plugin trust --builtin-all requires --yes too", async () => {
    const { socketPath } = await bootPluginRouter();
    const out = captureOutput();
    const code = await runCli(["plugin", "trust", "--builtin-all"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(out.lines.join("")).toMatch(/Re-run with --yes/);
  });

  it("plugin trust --builtin-all --yes trusts every built-in", async () => {
    const { socketPath } = await bootPluginRouter();
    const out = captureOutput();
    const code = await runCli(["plugin", "trust", "--builtin-all", "--yes"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(out.lines.join(""))).toEqual({ trusted: [{ pluginId: "deploy-docker" }] });
  });

  it("plugin untrust --yes calls the admin socket", async () => {
    const { socketPath } = await bootPluginRouter();
    const out = captureOutput();
    const code = await runCli(["plugin", "untrust", "deploy-docker", "--yes"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(out.lines.join(""))).toEqual({ pluginId: "deploy-docker", untrusted: true });
  });

  async function bootPlanRouter() {
    const router = new JsonUdsRouter();
    let approveCalls: unknown[] = [];
    let revokeCalls: unknown[] = [];
    router.register("GET", "/plans", async () => ({
      status: 200,
      body: { plans: [{ serviceId: "jellyfin", projectionHash: "abc123", approved: false }] },
    }));
    router.register("GET", "/plans/:id", async ({ params }) =>
      params.id === "jellyfin"
        ? { status: 200, body: { serviceId: "jellyfin", projectionHash: "abc123", approved: false, humanRendering: "image: x" } }
        : { status: 404, body: { error: "not_found" } },
    );
    router.register("POST", "/plans/approve", async ({ body }) => {
      approveCalls.push(body);
      return { status: 200, body: { approved: true, serviceId: "jellyfin", projectionHash: "abc123" } };
    });
    router.register("POST", "/plans/revoke", async ({ body }) => {
      revokeCalls.push(body);
      return { status: 200, body: { revoked: true, projectionHash: (body as { projectionHash: string }).projectionHash } };
    });
    const dir = await mkdtemp(join(tmpdir(), "wanfw-cli-plan-"));
    dirs.push(dir);
    const socketPath = join(dir, "admin.sock");
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));
    return { socketPath, approveCalls: () => approveCalls, revokeCalls: () => revokeCalls };
  }

  it("plan list: prints gated plans", async () => {
    const { socketPath } = await bootPlanRouter();
    const out = captureOutput();
    const code = await runCli(["plan", "list"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(out.lines.join(""))).toEqual({ plans: [{ serviceId: "jellyfin", projectionHash: "abc123", approved: false }] });
  });

  it("plan show: prints one plan's detail", async () => {
    const { socketPath } = await bootPlanRouter();
    const out = captureOutput();
    const code = await runCli(["plan", "show", "jellyfin"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(out.lines.join("")).humanRendering).toBe("image: x");
  });

  it("plan approve: requires --service or --hash", async () => {
    const { socketPath, approveCalls } = await bootPlanRouter();
    const out = captureOutput();
    const code = await runCli(["plan", "approve"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.usage);
    expect(approveCalls()).toHaveLength(0);
  });

  it("plan approve --service calls the admin socket with serviceId", async () => {
    const { socketPath, approveCalls } = await bootPlanRouter();
    const out = captureOutput();
    const code = await runCli(["plan", "approve", "--service", "jellyfin"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(approveCalls()).toEqual([{ serviceId: "jellyfin", projectionHash: undefined }]);
  });

  it("plan approve --hash calls the admin socket with projectionHash", async () => {
    const { socketPath, approveCalls } = await bootPlanRouter();
    const out = captureOutput();
    const code = await runCli(["plan", "approve", "--hash", "abc123"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(approveCalls()).toEqual([{ serviceId: undefined, projectionHash: "abc123" }]);
  });

  it("plan revoke calls the admin socket with the projection hash", async () => {
    const { socketPath, revokeCalls } = await bootPlanRouter();
    const out = captureOutput();
    const code = await runCli(["plan", "revoke", "abc123"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(revokeCalls()).toEqual([{ projectionHash: "abc123" }]);
  });

  async function bootSecretRouter() {
    const router = new JsonUdsRouter();
    const setCalls: unknown[] = [];
    const unsetCalls: unknown[] = [];
    router.register("GET", "/secrets", async () => ({
      status: 200,
      body: { secrets: [{ name: "cert-letsencrypt-dns01/acme-account-key", lastRotated: "2026-01-01T00:00:00.000Z" }] },
    }));
    router.register("POST", "/secrets", async ({ body }) => {
      setCalls.push(body);
      return { status: 200, body: { name: (body as { name: string }).name, set: true } };
    });
    router.register("POST", "/secrets/unset", async ({ body }) => {
      unsetCalls.push(body);
      return { status: 200, body: { name: (body as { name: string }).name, unset: true } };
    });
    const dir = await mkdtemp(join(tmpdir(), "wanfw-cli-secret-"));
    dirs.push(dir);
    const socketPath = join(dir, "admin.sock");
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));
    return { socketPath, setCalls: () => setCalls, unsetCalls: () => unsetCalls };
  }

  it("secret list: prints names and lastRotated, never a value field", async () => {
    const { socketPath } = await bootSecretRouter();
    const out = captureOutput();
    const code = await runCli(["secret", "list"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    const body = JSON.parse(out.lines.join(""));
    expect(body.secrets).toEqual([{ name: "cert-letsencrypt-dns01/acme-account-key", lastRotated: "2026-01-01T00:00:00.000Z" }]);
  });

  it("secret set: reads the value from stdin, never argv, and forwards it to the admin socket", async () => {
    const { socketPath, setCalls } = await bootSecretRouter();
    const out = captureOutput();
    const code = await runCli(["secret", "set", "cert-letsencrypt-dns01/acme-account-key"], {
      adminSocketPath: socketPath,
      ...out,
      readStdin: async () => "the-secret-value",
    });
    expect(code).toBe(EXIT_CODES.ok);
    expect(setCalls()).toEqual([{ name: "cert-letsencrypt-dns01/acme-account-key", value: "the-secret-value" }]);
  });

  it("secret set: an extra positional argument (a value on argv) is rejected as a usage error, never reaches the admin socket", async () => {
    const { socketPath, setCalls } = await bootSecretRouter();
    const out = captureOutput();
    const code = await runCli(["secret", "set", "ns/name", "value-on-argv"], {
      adminSocketPath: socketPath,
      ...out,
      readStdin: async () => "irrelevant",
    });
    expect(code).toBe(EXIT_CODES.usage);
    expect(setCalls()).toHaveLength(0);
  });

  it("secret set: empty stdin is a usage error", async () => {
    const { socketPath, setCalls } = await bootSecretRouter();
    const out = captureOutput();
    const code = await runCli(["secret", "set", "ns/name"], {
      adminSocketPath: socketPath,
      ...out,
      readStdin: async () => "",
    });
    expect(code).toBe(EXIT_CODES.usage);
    expect(setCalls()).toHaveLength(0);
  });

  it("secret unset: calls the admin socket with the name", async () => {
    const { socketPath, unsetCalls } = await bootSecretRouter();
    const out = captureOutput();
    const code = await runCli(["secret", "unset", "cert-letsencrypt-dns01/acme-account-key"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(unsetCalls()).toEqual([{ name: "cert-letsencrypt-dns01/acme-account-key" }]);
  });

  async function bootCertRouter() {
    const router = new JsonUdsRouter();
    const rollbackCalls: string[] = [];
    router.register("GET", "/certs", async () => ({
      status: 200,
      body: { certs: [{ name: "wildcard", currentGeneration: 2, generations: [1, 2] }] },
    }));
    router.register("POST", "/certs/:name/rollback", async ({ params }) => {
      rollbackCalls.push(params.name!);
      return { status: 200, body: { name: params.name!, rolledBackTo: 1 } };
    });
    const dir = await mkdtemp(join(tmpdir(), "wanfw-cli-cert-"));
    dirs.push(dir);
    const socketPath = join(dir, "admin.sock");
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));
    return { socketPath, rollbackCalls: () => rollbackCalls };
  }

  it("cert list: prints stored certs and their generations", async () => {
    const { socketPath } = await bootCertRouter();
    const out = captureOutput();
    const code = await runCli(["cert", "list"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    const body = JSON.parse(out.lines.join(""));
    expect(body.certs).toEqual([{ name: "wildcard", currentGeneration: 2, generations: [1, 2] }]);
  });

  it("cert rollback: calls the admin socket with the name", async () => {
    const { socketPath, rollbackCalls } = await bootCertRouter();
    const out = captureOutput();
    const code = await runCli(["cert", "rollback", "wildcard"], { adminSocketPath: socketPath, ...out });
    expect(code).toBe(EXIT_CODES.ok);
    expect(rollbackCalls()).toEqual(["wildcard"]);
  });
});
