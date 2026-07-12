import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { listenOnUnixSocket, JsonUdsRouter } from "@wanfw/orchestrator";
import { runInit, PRODUCTION_BUILTIN_IDS } from "./init.js";

// A hand-rolled fake admin socket, not the real orchestrator's router --
// this test is about the wizard's own call sequence and prompt-driven
// branching, which is independently covered; the real admin-socket routes
// (/framework, /plugins/trust-builtins, /secrets, /network/wan-ip) are
// covered by the orchestrator's own admin-socket.test.ts.
describe("runInit (T5.3 wizard)", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    servers.splice(0).forEach((s) => s.close());
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  function scriptedPrompt(answers: string[]): (q: string) => Promise<string> {
    let i = 0;
    return async () => answers[i++] ?? "";
  }

  async function bootFakeAdmin(overrides?: { existingFramework?: unknown; wanIp?: string | null; statusOk?: string }) {
    const router = new JsonUdsRouter();
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];

    router.register("GET", "/framework", async () => ({ status: 200, body: { framework: overrides?.existingFramework ?? null } }));
    router.register("POST", "/plugins/trust-builtins", async ({ body }) => {
      calls.push({ method: "POST", path: "/plugins/trust-builtins", body });
      return { status: 200, body: { trusted: [] } };
    });
    router.register("POST", "/secrets", async ({ body }) => {
      calls.push({ method: "POST", path: "/secrets", body });
      return { status: 200, body: { set: true } };
    });
    router.register("POST", "/framework", async ({ body }) => {
      calls.push({ method: "POST", path: "/framework", body });
      return { status: 200, body: { set: true } };
    });
    router.register("GET", "/status", async () => ({ status: 200, body: { phase: overrides?.statusOk ?? "live" } }));
    router.register("GET", "/network/wan-ip", async () => ({ status: 200, body: { ip: overrides?.wanIp === undefined ? "203.0.113.5" : overrides.wanIp } }));

    const dir = await mkdtemp(join(tmpdir(), "wanfw-init-"));
    dirs.push(dir);
    const socketPath = join(dir, "admin.sock");
    servers.push(listenOnUnixSocket(router, socketPath));
    await new Promise((r) => setTimeout(r, 50));

    const statusDir = await mkdtemp(join(tmpdir(), "wanfw-init-status-"));
    dirs.push(statusDir);

    return { socketPath, statusDir, calls };
  }

  function captureOutput() {
    const lines: string[] = [];
    const errLines: string[] = [];
    return { lines, errLines, stdout: (l: string) => lines.push(l), stderr: (l: string) => errLines.push(l) };
  }

  it("happy path (bridge provider): trusts production builtins (never dns-mock), stores secrets, writes the framework doc, writes a setup token", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin();
    const out = captureOutput();
    const prompt = scriptedPrompt([
      "example.tld", // domain
      "ops@example.tld", // acmeEmail
      "myuser", // api-user
      "myusername", // username
      "mykey", // api-key
      "n", // use macvlan? no
    ]);

    const code = await runInit({
      adminSocketPath: socketPath,
      stdout: out.stdout,
      stderr: out.stderr,
      prompt,
      statusDir,
      sleep: async () => {},
    });

    expect(code).toBe(0);

    const trustCall = calls.find((c) => c.path === "/plugins/trust-builtins");
    expect((trustCall!.body as { ids: string[] }).ids).toEqual(PRODUCTION_BUILTIN_IDS);
    expect((trustCall!.body as { ids: string[] }).ids).not.toContain("dns-mock");

    const secretCalls = calls.filter((c) => c.path === "/secrets");
    expect(secretCalls).toHaveLength(3);
    expect(secretCalls.map((c) => (c.body as { name: string }).name).sort()).toEqual([
      "dns-namecheap/api-key",
      "dns-namecheap/api-user",
      "dns-namecheap/username",
    ]);

    const frameworkCall = calls.find((c) => c.path === "/framework");
    const spec = (frameworkCall!.body as { spec: Record<string, unknown> }).spec;
    expect(spec.domain).toBe("example.tld");
    expect((spec.roles as Record<string, string>).networkProvider).toBe("network-bridge");
    expect((spec.roles as Record<string, string>).certIssuer).toBe("cert-letsencrypt-dns01");

    const tokenFile = JSON.parse(await readFile(join(statusDir, "setup-token.json"), "utf8"));
    expect(tokenFile.token).toMatch(/^[0-9a-f]{32}$/);
    expect(new Date(tokenFile.createdAt).getTime()).toBeGreaterThan(0);

    expect(out.lines.some((l) => l.includes("setup token"))).toBe(true);
  });

  it("macvlan provider: prompts for parent/CIDR/gateway and includes them in the framework doc", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin();
    const out = captureOutput();
    const prompt = scriptedPrompt([
      "example.tld",
      "ops@example.tld",
      "myuser",
      "myusername",
      "mykey",
      "y", // use macvlan? yes
      "eth0", // parent
      "192.168.1.240/29", // reservedCidr
      "192.168.1.1", // gateway
    ]);

    const code = await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });
    expect(code).toBe(0);

    const frameworkCall = calls.find((c) => c.path === "/framework");
    const spec = (frameworkCall!.body as { spec: Record<string, unknown> }).spec;
    expect((spec.roles as Record<string, string>).networkProvider).toBe("network-macvlan");
    expect(spec.network).toEqual({
      lanInterface: "eth0",
      macvlan: { parent: "eth0", reservedCidr: "192.168.1.240/29", gateway: "192.168.1.1" },
    });
  });

  it("aborts cleanly when a framework doc already exists and the operator declines to overwrite", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin({ existingFramework: { spec: { domain: "old.tld" } } });
    const out = captureOutput();
    const prompt = scriptedPrompt(["n"]); // decline overwrite
    const code = await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0); // never proceeded to trust/secrets/framework
    expect(out.lines).toContain("aborted");
  });

  it("still succeeds and prints a fallback message when WAN IP detection fails", async () => {
    const { socketPath, statusDir } = await bootFakeAdmin({ wanIp: null });
    const out = captureOutput();
    const prompt = scriptedPrompt(["example.tld", "ops@example.tld", "u", "un", "k", "n"]);
    const code = await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });
    expect(code).toBe(0);
    expect(out.lines.some((l) => l.includes("could not detect WAN IP"))).toBe(true);
  });
});
