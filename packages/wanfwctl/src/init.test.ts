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

  async function bootFakeAdmin(overrides?: {
    existingFramework?: unknown;
    wanIp?: string | null;
    statusOk?: string;
    probeMacvlan?: { ok: boolean; reason?: string } | Array<{ ok: boolean; reason?: string }>;
    existingSecretNames?: string[];
  }) {
    const router = new JsonUdsRouter();
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];

    router.register("GET", "/framework", async () => ({ status: 200, body: { framework: overrides?.existingFramework ?? null } }));
    router.register("GET", "/secrets", async () => ({
      status: 200,
      body: { secrets: (overrides?.existingSecretNames ?? []).map((name) => ({ name, lastRotated: "2026-01-01T00:00:00.000Z" })) },
    }));
    let probeCallCount = 0;
    router.register("POST", "/network/probe-macvlan", async ({ body }) => {
      calls.push({ method: "POST", path: "/network/probe-macvlan", body });
      const probeMacvlan = overrides?.probeMacvlan ?? { ok: true };
      const result = Array.isArray(probeMacvlan) ? (probeMacvlan[probeCallCount] ?? probeMacvlan.at(-1)!) : probeMacvlan;
      probeCallCount += 1;
      return { status: 200, body: result };
    });
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
    router.register("POST", "/operator-info", async ({ body }) => {
      calls.push({ method: "POST", path: "/operator-info", body });
      return { status: 200, body: { set: true } };
    });

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
    expect(out.lines.some((l) => l.includes("API User: the Namecheap account enabled for API access"))).toBe(true);
    expect(out.lines.some((l) => l.includes("almost always the same value as"))).toBe(true);

    const operatorInfoCall = calls.find((c) => c.path === "/operator-info");
    const operatorInfo = operatorInfoCall!.body as { domain: string; wanIp: string; networkProvider: string; instructions: string[] };
    expect(operatorInfo.domain).toBe("example.tld");
    expect(operatorInfo.wanIp).toBe("203.0.113.5");
    expect(operatorInfo.networkProvider).toBe("network-bridge");
    expect(operatorInfo.instructions).toHaveLength(2);
    expect(operatorInfo.instructions[0]).toContain("example.tld");
  });

  it("macvlan provider (non-VLAN LAN): prompts for parent/CIDR/gateway and includes them in the framework doc", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin();
    const out = captureOutput();
    const prompt = scriptedPrompt([
      "example.tld",
      "ops@example.tld",
      "myuser",
      "myusername",
      "mykey",
      "y", // use macvlan? yes
      "n", // is your LAN VLAN-segmented? no
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

  it("macvlan provider (VLAN-segmented LAN): composes parent from base interface + VLAN ID rather than requiring the operator to hand-construct it", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin();
    const out = captureOutput();
    const prompt = scriptedPrompt([
      "example.tld",
      "ops@example.tld",
      "myuser",
      "myusername",
      "mykey",
      "y", // use macvlan? yes
      "y", // is your LAN VLAN-segmented? yes
      "eth0", // base interface
      "50", // VLAN ID
      "192.168.1.240/29", // reservedCidr
      "192.168.1.1", // gateway
    ]);

    const code = await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });
    expect(code).toBe(0);

    const frameworkCall = calls.find((c) => c.path === "/framework");
    const spec = (frameworkCall!.body as { spec: Record<string, unknown> }).spec;
    expect(spec.network).toEqual({
      lanInterface: "eth0.50",
      macvlan: { parent: "eth0.50", reservedCidr: "192.168.1.240/29", gateway: "192.168.1.1" },
    });
  });

  it("loops back to the review (does not hard-abort) when the live macvlan probe fails, and the operator can then quit", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin({ probeMacvlan: { ok: false, reason: "no promiscuous mode on 'eth0.50'" } });
    const out = captureOutput();
    const prompt = scriptedPrompt([
      "example.tld",
      "ops@example.tld",
      "myuser",
      "myusername",
      "mykey",
      "y", // use macvlan? yes
      "y", // is your LAN VLAN-segmented? yes
      "eth0", // base interface
      "50", // VLAN ID
      "192.168.1.240/29", // reservedCidr
      "192.168.1.1", // gateway
      "", // Proceed? -> confirm -> probe fails -> loops back to review
      "q", // abort instead of retrying
    ]);

    const code = await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });
    expect(code).toBe(0);
    expect(out.lines).toContain("aborted");
    expect(out.lines.some((l) => l.includes("no promiscuous mode on 'eth0.50'"))).toBe(true);
    expect(calls.find((c) => c.path === "/framework")).toBeUndefined();

    const probeCall = calls.find((c) => c.path === "/network/probe-macvlan");
    expect((probeCall!.body as { parent: string }).parent).toBe("eth0.50");
  });

  it("recovers from a failed macvlan probe by jumping back to section 3, fixing the interface, and re-confirming", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin({
      probeMacvlan: [{ ok: false, reason: "no promiscuous mode on 'eth0.50'" }, { ok: true }],
    });
    const out = captureOutput();
    const prompt = scriptedPrompt([
      "example.tld",
      "ops@example.tld",
      "myuser",
      "myusername",
      "mykey",
      "y", // use macvlan? yes
      "y", // is your LAN VLAN-segmented? yes
      "eth0", // base interface
      "50", // VLAN ID
      "192.168.1.240/29", // reservedCidr
      "192.168.1.1", // gateway
      "", // Proceed? -> confirm -> probe #1 fails -> back to review
      "3", // jump to network section to fix it
      "y", // use macvlan? yes (default carried over)
      "n", // is your LAN VLAN-segmented? no this time -- plain interface
      "eth0", // parent (no VLAN)
      "192.168.1.240/29", // reservedCidr
      "192.168.1.1", // gateway
      "", // Proceed? -> confirm -> probe #2 passes
    ]);

    const code = await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });
    expect(code).toBe(0);

    const probeCalls = calls.filter((c) => c.path === "/network/probe-macvlan");
    expect(probeCalls).toHaveLength(2);
    expect((probeCalls[0]!.body as { parent: string }).parent).toBe("eth0.50");
    expect((probeCalls[1]!.body as { parent: string }).parent).toBe("eth0");

    const frameworkCall = calls.find((c) => c.path === "/framework");
    const spec = (frameworkCall!.body as { spec: Record<string, unknown> }).spec;
    expect(spec.network).toEqual({
      lanInterface: "eth0",
      macvlan: { parent: "eth0", reservedCidr: "192.168.1.240/29", gateway: "192.168.1.1" },
    });
  });

  it("prints a review listing all three sections before committing anything", async () => {
    const { socketPath, statusDir } = await bootFakeAdmin();
    const out = captureOutput();
    const prompt = scriptedPrompt(["example.tld", "ops@example.tld", "myuser", "myusername", "mykey", "n"]);
    await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });

    expect(out.lines.some((l) => l.includes("--- Review ---"))).toBe(true);
    expect(out.lines.some((l) => l.includes("1) Domain & ACME email: example.tld / ops@example.tld"))).toBe(true);
    expect(out.lines.some((l) => l.includes("2) DNS credentials") && l.includes("new value provided"))).toBe(true);
    expect(out.lines.some((l) => l.includes("3) Network: bridge"))).toBe(true);
  });

  it("jumping back to section 1 from the review re-collects domain/ACME email and reflects the change in the framework doc", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin();
    const out = captureOutput();
    const prompt = scriptedPrompt([
      "typo.tld",
      "ops@example.tld",
      "myuser",
      "myusername",
      "mykey",
      "n", // use macvlan? no
      "1", // jump back to fix the domain
      "example.tld", // corrected domain
      "ops@example.tld", // acmeEmail (re-asked, same answer)
      "", // Proceed? -> confirm
    ]);

    const code = await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });
    expect(code).toBe(0);

    const frameworkCall = calls.find((c) => c.path === "/framework");
    const spec = (frameworkCall!.body as { spec: Record<string, unknown> }).spec;
    expect(spec.domain).toBe("example.tld");
  });

  it("re-running with an existing framework document prefills domain/ACME/network as defaults, and DNS fields already in the secrets store become optional (Enter keeps them, nothing re-POSTed)", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin({
      existingFramework: {
        spec: {
          domain: "example.tld",
          acmeEmail: "ops@example.tld",
          roles: { networkProvider: "network-macvlan" },
          network: { lanInterface: "eth0.50", macvlan: { parent: "eth0.50", reservedCidr: "192.168.1.240/29", gateway: "192.168.1.1" } },
        },
      },
      existingSecretNames: ["dns-namecheap/api-user", "dns-namecheap/username", "dns-namecheap/api-key"],
    });
    const out = captureOutput();
    const prompt = scriptedPrompt([
      "y", // edit the existing framework doc?
      "", // domain -> keep default (example.tld)
      "", // acmeEmail -> keep default
      "", // api-user -> keep current (already set)
      "", // username -> keep current
      "", // api-key -> keep current
      "", // use macvlan? -> keep default (yes, prefilled from existing doc)
      "", // is your LAN VLAN-segmented? -> keep default (yes, derived from 'eth0.50')
      "", // base interface -> keep default 'eth0'
      "", // VLAN ID -> keep default '50'
      "", // reservedCidr -> keep default
      "", // gateway -> keep default
      "", // Proceed? -> confirm
    ]);

    const code = await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });
    expect(code).toBe(0);

    // Nothing was re-typed for any DNS field, so none of them get re-POSTed.
    expect(calls.filter((c) => c.path === "/secrets")).toHaveLength(0);

    const frameworkCall = calls.find((c) => c.path === "/framework");
    const spec = (frameworkCall!.body as { spec: Record<string, unknown> }).spec;
    expect(spec.domain).toBe("example.tld");
    expect(spec.network).toEqual({
      lanInterface: "eth0.50",
      macvlan: { parent: "eth0.50", reservedCidr: "192.168.1.240/29", gateway: "192.168.1.1" },
    });
  });

  it("re-running still requires a DNS field that was never actually set, even with an existing framework document", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin({
      existingFramework: { spec: { domain: "example.tld", acmeEmail: "ops@example.tld", roles: { networkProvider: "network-bridge" } } },
      existingSecretNames: ["dns-namecheap/api-user", "dns-namecheap/username"], // api-key was never set
    });
    const out = captureOutput();
    const prompt = scriptedPrompt([
      "y", // edit?
      "", // domain -> keep
      "", // acmeEmail -> keep
      "", // api-user -> keep current
      "", // username -> keep current
      "", // api-key -> blank, but not keep-able (never set) -> re-prompted
      "newkey", // api-key -> now provided
      "", // use macvlan? -> keep default (no)
      "", // Proceed? -> confirm
    ]);

    const code = await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });
    expect(code).toBe(0);
    expect(out.lines.some((l) => l.includes("(required)"))).toBe(true);

    const secretCalls = calls.filter((c) => c.path === "/secrets");
    expect(secretCalls).toHaveLength(1);
    expect((secretCalls[0]!.body as { name: string; value: string }).name).toBe("dns-namecheap/api-key");
    expect((secretCalls[0]!.body as { name: string; value: string }).value).toBe("newkey");
  });

  it("re-prompts on a malformed CIDR/gateway/interface answer instead of passing it through", async () => {
    const { socketPath, statusDir, calls } = await bootFakeAdmin();
    const out = captureOutput();
    const prompt = scriptedPrompt([
      "example.tld",
      "ops@example.tld",
      "myuser",
      "myusername",
      "mykey",
      "y", // use macvlan? yes
      "n", // is your LAN VLAN-segmented? no
      "not an interface!", // invalid, re-prompted
      "eth0", // valid
      "not-a-cidr", // invalid, re-prompted
      "192.168.1.240/29", // valid
      "192.168.1.1",
    ]);

    const code = await runInit({ adminSocketPath: socketPath, stdout: out.stdout, stderr: out.stderr, prompt, statusDir, sleep: async () => {} });
    expect(code).toBe(0);
    expect(out.lines.some((l) => l.includes("invalid format"))).toBe(true);

    const frameworkCall = calls.find((c) => c.path === "/framework");
    const spec = (frameworkCall!.body as { spec: Record<string, unknown> }).spec;
    expect(spec.network).toEqual({
      lanInterface: "eth0",
      macvlan: { parent: "eth0", reservedCidr: "192.168.1.240/29", gateway: "192.168.1.1" },
    });
  });

  it("aborts cleanly when a framework document already exists and the operator declines to overwrite", async () => {
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
