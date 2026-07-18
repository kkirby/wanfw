import { describe, expect, it } from "vitest";
import { buildRenewalStage } from "./renewal-stage.js";
import type { PluginInvoker, PlanGraph } from "./plan-stage.js";
import type { FrameworkRolesHolder } from "./core-stages.js";
import type { RenewalState } from "../renewal/scheduler.js";
import type { ReconcileRunContext } from "./types.js";
import type { DesiredState } from "../desired-state/index.js";

function planGraph(names: string[]): PlanGraph {
  return { servicePlans: {}, routes: [], certRequirements: { mode: "internal-ca", names } };
}

function desiredStateWithDomain(domain: string): DesiredState {
  return {
    framework: { kind: "Framework", id: "framework", spec: { domain }, schemaVersion: 1, sourcePath: "framework" },
    services: new Map(),
    pluginConfigs: new Map(),
    errors: [],
  };
}

function fakeStore(initial?: { storedAt: string; names: string[] }) {
  let meta = initial;
  const storeCalls: unknown[] = [];
  return {
    readCertMeta: () => meta,
    setMeta: (m: { storedAt: string; names: string[] } | undefined) => {
      meta = m;
    },
    storeCalls,
  };
}

function fakeRenewalStateStore() {
  const states = new Map<string, RenewalState>();
  return {
    read: (name: string): RenewalState => states.get(name) ?? { consecutiveFailures: 0 },
    write: (name: string, state: RenewalState) => states.set(name, state),
    states,
  };
}

describe("RENEWAL stage (§9, T4.6)", () => {
  it("is a no-op when no names are required yet (nothing exposed)", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: {} };
    const store = fakeStore();
    const renewalStates = fakeRenewalStateStore();
    let invoked = false;
    const stage = buildRenewalStage({
      invokePlugin: async () => {
        invoked = true;
        return { ok: true };
      },
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
    });
    const ctx: ReconcileRunContext = { planGraph: planGraph([]) };
    const result = await stage.run(ctx);
    expect(result.ok).toBe(true);
    expect(invoked).toBe(false);
    expect(ctx.degraded).toBeUndefined();
  });

  it("invokes cert.ensure on the bound certIssuer when a cert is due (uncovered names)", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: { certIssuer: "cert-letsencrypt-dns01" } };
    const store = fakeStore(); // never stored
    const renewalStates = fakeRenewalStateStore();
    let invokeArgs: { pluginId: string; task: string; args: unknown } | undefined;
    const invoker: PluginInvoker = async (pluginId, task, args) => {
      invokeArgs = { pluginId, task, args };
      return { ok: true, result: { generation: 1 } };
    };
    const stage = buildRenewalStage({
      invokePlugin: invoker,
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
      now: () => new Date("2026-07-12T00:00:00Z"),
    });
    const ctx: ReconcileRunContext = {
      planGraph: planGraph(["kavita.example.tld"]),
      desiredState: desiredStateWithDomain("example.tld"),
    };
    const result = await stage.run(ctx);

    expect(result.ok).toBe(true);
    expect(invokeArgs).toEqual({
      pluginId: "cert-letsencrypt-dns01",
      task: "cert.ensure",
      args: { certName: "wildcard", names: ["kavita.example.tld"], zone: "example.tld" },
    });
    expect(renewalStates.read("wildcard")).toEqual({
      lastAttemptAt: "2026-07-12T00:00:00.000Z",
      lastSuccessAt: "2026-07-12T00:00:00.000Z",
      consecutiveFailures: 0,
    });
  });

  it("passes the framework's domain as 'zone' -- regression test: this used to be omitted entirely, breaking every real dns-namecheap cert.ensure call with an opaque 'reading split of undefined' error downstream", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: { certIssuer: "cert-letsencrypt-dns01" } };
    const store = fakeStore();
    const renewalStates = fakeRenewalStateStore();
    let invokeArgs: { args: unknown } | undefined;
    const stage = buildRenewalStage({
      invokePlugin: async (pluginId, task, args) => {
        invokeArgs = { args };
        return { ok: true, result: {} };
      },
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
    });
    const ctx: ReconcileRunContext = {
      planGraph: planGraph(["kavita.home.kirbatski.us"]),
      desiredState: desiredStateWithDomain("home.kirbatski.us"),
    };
    await stage.run(ctx);
    expect((invokeArgs?.args as { zone?: string }).zone).toBe("home.kirbatski.us");
  });

  it("triggers onCertChange after a successful renewal, to re-reconcile with the fresh cert", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: { certIssuer: "cert-letsencrypt-dns01" } };
    const store = fakeStore();
    const renewalStates = fakeRenewalStateStore();
    let fired = false;
    const stage = buildRenewalStage({
      invokePlugin: async () => ({ ok: true, result: {} }),
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
      onCertChange: () => {
        fired = true;
      },
    });
    await stage.run({ planGraph: planGraph(["kavita.example.tld"]) });
    expect(fired).toBe(true);
  });

  it("records a failure and increments consecutiveFailures without failing the stage", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: { certIssuer: "cert-letsencrypt-dns01" } };
    const store = fakeStore();
    const renewalStates = fakeRenewalStateStore();
    const stage = buildRenewalStage({
      invokePlugin: async () => ({ ok: false, error: { code: "acme_error", message: "rate limited" } }),
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
      now: () => new Date("2026-07-12T00:00:00Z"),
    });
    const ctx: ReconcileRunContext = { planGraph: planGraph(["kavita.example.tld"]) };
    const result = await stage.run(ctx);

    expect(result.ok).toBe(true); // renewal failure never fails the pipeline
    expect(renewalStates.read("wildcard").consecutiveFailures).toBe(1);
    expect(renewalStates.read("wildcard").lastAttemptAt).toBe("2026-07-12T00:00:00.000Z");
    expect(renewalStates.read("wildcard").lastSuccessAt).toBeUndefined();
    expect(renewalStates.read("wildcard").lastError).toEqual({ code: "acme_error", message: "rate limited" });
  });

  it("folds a previously recorded renewal failure's real error into ctx.degradedReason when escalated", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: {} }; // no issuer bound, so this run won't overwrite lastError
    const store = fakeStore({ storedAt: "2026-04-16T00:00:00Z", names: ["kavita.example.tld"] }); // 87 days old, 3 remaining
    const renewalStates = fakeRenewalStateStore();
    renewalStates.write("wildcard", {
      consecutiveFailures: 3,
      lastAttemptAt: "2026-07-11T00:00:00Z",
      lastError: { code: "acme_error", message: "ACME rate limited, retry after 2026-07-13T00:00:00Z" },
    });
    const stage = buildRenewalStage({
      invokePlugin: async () => ({ ok: true, result: {} }),
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
      now: () => new Date("2026-07-12T00:00:00Z"),
    });
    const ctx: ReconcileRunContext = { planGraph: planGraph(["kavita.example.tld"]) };
    await stage.run(ctx);

    expect(ctx.degraded).toBe(true);
    expect(ctx.degradedReason).toMatchObject({ stage: "renewal" });
    expect((ctx.degradedReason as { message: string }).message).toContain(
      "ACME rate limited, retry after 2026-07-13T00:00:00Z",
    );
  });

  it("does not invoke the issuer when the currently stored cert is not yet due for renewal", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: { certIssuer: "cert-letsencrypt-dns01" } };
    const store = fakeStore({ storedAt: "2026-07-01T00:00:00Z", names: ["kavita.example.tld"] }); // 11 days old, well within 90
    const renewalStates = fakeRenewalStateStore();
    let invoked = false;
    const stage = buildRenewalStage({
      invokePlugin: async () => {
        invoked = true;
        return { ok: true, result: {} };
      },
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
      now: () => new Date("2026-07-12T00:00:00Z"),
    });
    const result = await stage.run({ planGraph: planGraph(["kavita.example.tld"]) });
    expect(result.ok).toBe(true);
    expect(invoked).toBe(false);
  });

  it("self-heals stale failure bookkeeping once a matching cert exists but isn't due -- regression: an out-of-band success (e.g. a manual `wanfwctl plugin invoke cert.ensure` while debugging) used to leave 'N failed attempt(s)' displayed forever, since this stage never got the chance to record its own success", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: { certIssuer: "cert-letsencrypt-dns01" } };
    const store = fakeStore({ storedAt: "2026-07-18T20:16:20Z", names: ["kavita.example.tld"] }); // freshly (re)issued out-of-band
    const renewalStates = fakeRenewalStateStore();
    renewalStates.write("wildcard", {
      lastAttemptAt: "2026-07-18T19:04:48Z",
      consecutiveFailures: 2,
      lastError: { code: "invoke_error", message: "dns-provider 'dns-namecheap' rejected the DNS change: Namecheap API error: Domain name not found" },
    });
    let invoked = false;
    const stage = buildRenewalStage({
      invokePlugin: async () => {
        invoked = true;
        return { ok: true, result: {} };
      },
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
      now: () => new Date("2026-07-18T20:30:00Z"),
    });
    const result = await stage.run({ planGraph: planGraph(["kavita.example.tld"]) });
    expect(result.ok).toBe(true);
    expect(invoked).toBe(false); // not due -- the stage must not re-attempt just to clear stale state
    expect(renewalStates.read("wildcard")).toEqual({ lastSuccessAt: "2026-07-18T20:16:20Z", consecutiveFailures: 0 });
  });

  it("leaves failure bookkeeping alone when the cert genuinely isn't due yet and nothing has failed", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: { certIssuer: "cert-letsencrypt-dns01" } };
    const store = fakeStore({ storedAt: "2026-07-01T00:00:00Z", names: ["kavita.example.tld"] });
    const renewalStates = fakeRenewalStateStore();
    const stage = buildRenewalStage({
      invokePlugin: async () => ({ ok: true, result: {} }),
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
      now: () => new Date("2026-07-12T00:00:00Z"),
    });
    await stage.run({ planGraph: planGraph(["kavita.example.tld"]) });
    expect(renewalStates.states.has("wildcard")).toBe(false); // never written -- nothing to self-heal
  });

  it("flags ctx.degraded when the served cert has fewer than 7 days remaining, independent of due-ness", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: {} }; // no issuer bound at all
    const store = fakeStore({ storedAt: "2026-04-16T00:00:00Z", names: ["kavita.example.tld"] }); // 87 days old, 3 remaining
    const renewalStates = fakeRenewalStateStore();
    const stage = buildRenewalStage({
      invokePlugin: async () => ({ ok: true, result: {} }),
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
      now: () => new Date("2026-07-12T00:00:00Z"),
    });
    const ctx: ReconcileRunContext = { planGraph: planGraph(["kavita.example.tld"]) };
    const result = await stage.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.degraded).toBe(true);
    expect(ctx.degradedReason).toMatchObject({ stage: "renewal" });
  });

  it("flags ctx.degraded when names are required but no cert has ever been issued", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: {} };
    const store = fakeStore();
    const renewalStates = fakeRenewalStateStore();
    const stage = buildRenewalStage({
      invokePlugin: async () => ({ ok: true, result: {} }),
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
      now: () => new Date("2026-07-12T00:00:00Z"),
    });
    const ctx: ReconcileRunContext = { planGraph: planGraph(["kavita.example.tld"]) };
    await stage.run(ctx);
    expect(ctx.degraded).toBe(true);
  });

  it("does not flag degraded while the served cert still has 7+ days remaining", async () => {
    const rolesHolder: FrameworkRolesHolder = { roles: { certIssuer: "cert-letsencrypt-dns01" } };
    const store = fakeStore({ storedAt: "2026-04-20T00:00:00Z", names: ["kavita.example.tld"] }); // 83 days old, 7 remaining
    const renewalStates = fakeRenewalStateStore();
    const stage = buildRenewalStage({
      invokePlugin: async () => ({ ok: true, result: {} }),
      rolesHolder,
      readRenewalState: renewalStates.read,
      writeRenewalState: renewalStates.write,
      readCertMeta: store.readCertMeta,
      now: () => new Date("2026-07-12T00:00:00Z"),
    });
    const ctx: ReconcileRunContext = { planGraph: planGraph(["kavita.example.tld"]) };
    await stage.run(ctx);
    expect(ctx.degraded).toBeUndefined();
  });
});
