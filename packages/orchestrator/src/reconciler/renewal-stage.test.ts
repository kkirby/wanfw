import { describe, expect, it } from "vitest";
import { buildRenewalStage } from "./renewal-stage.js";
import type { PluginInvoker, PlanGraph } from "./plan-stage.js";
import type { FrameworkRolesHolder } from "./core-stages.js";
import type { RenewalState } from "../renewal/scheduler.js";
import type { ReconcileRunContext } from "./types.js";

function planGraph(names: string[]): PlanGraph {
  return { servicePlans: {}, routes: [], certRequirements: { mode: "internal-ca", names } };
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
    const ctx: ReconcileRunContext = { planGraph: planGraph(["kavita.example.tld"]) };
    const result = await stage.run(ctx);

    expect(result.ok).toBe(true);
    expect(invokeArgs).toEqual({
      pluginId: "cert-letsencrypt-dns01",
      task: "cert.ensure",
      args: { certName: "wildcard", names: ["kavita.example.tld"] },
    });
    expect(renewalStates.read("wildcard")).toEqual({
      lastAttemptAt: "2026-07-12T00:00:00.000Z",
      lastSuccessAt: "2026-07-12T00:00:00.000Z",
      consecutiveFailures: 0,
    });
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
