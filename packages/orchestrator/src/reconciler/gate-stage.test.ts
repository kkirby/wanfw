import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state-store/store.js";
import { buildGateStage, type GateSnapshotHolder } from "./gate-stage.js";
import type { DesiredState, LoadedDocument } from "../desired-state/index.js";
import type { PlanGraph } from "./plan-stage.js";
import type { ReconcileRunContext } from "./types.js";

function frameworkDoc(strictApprovals?: string): LoadedDocument {
  return {
    kind: "Framework",
    id: "framework",
    spec: {
      domain: "example.tld",
      deploymentMode: "subdomain",
      acmeEmail: "ops@example.tld",
      roles: { networkProvider: "network-bridge", proxyEngine: "proxy-caddy" },
      ...(strictApprovals ? { strictApprovals } : {}),
    },
    schemaVersion: 1,
    sourcePath: "framework.json",
  };
}

describe("GATE stage", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rm(d, { recursive: true, force: true }).catch(() => {}));
  });

  async function makeStore(): Promise<StateStore> {
    const dbDir = await mkdtemp(join(tmpdir(), "wanfw-gatestage-"));
    dirs.push(dbDir);
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    return store;
  }

  it("a powerful plan without a matching approval parks (approved=false) but the stage still succeeds", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = {
      servicePlans: { jellyfin: { image: "jellyfin/jellyfin:10.9.11", devices: ["/dev/dri/renderD128"] } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const validation = { jellyfin: { tier: "powerful" } };

    const stage = buildGateStage({ store }, holder);
    const result = await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);

    expect(result.ok).toBe(true);
    expect(holder.services.get("jellyfin")?.approved).toBe(false);
  });

  it("approving the exact projection hash flips the gate to approved on the next run", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const spec = { image: "jellyfin/jellyfin:10.9.11", devices: ["/dev/dri/renderD128"] };
    const planGraph: PlanGraph = {
      servicePlans: { jellyfin: spec },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const validation = { jellyfin: { tier: "powerful" } };
    const stage = buildGateStage({ store }, holder);

    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);
    const hash = holder.services.get("jellyfin")!.projectionHash;

    store.insertApproval({
      projection_hash: hash,
      service_id: "jellyfin",
      human_rendering: "x",
      sig: "sig",
      approved_at: new Date().toISOString(),
    });

    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);
    expect(holder.services.get("jellyfin")?.approved).toBe(true);
  });

  it("revoking parks the plan again on the next reconcile", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const spec = { image: "jellyfin/jellyfin:10.9.11", devices: ["/dev/dri/renderD128"] };
    const planGraph: PlanGraph = { servicePlans: { jellyfin: spec }, routes: [], certRequirements: { mode: "internal-ca", names: [] } };
    const validation = { jellyfin: { tier: "powerful" } };
    const stage = buildGateStage({ store }, holder);

    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);
    const hash = holder.services.get("jellyfin")!.projectionHash;
    store.insertApproval({ projection_hash: hash, service_id: "jellyfin", human_rendering: "x", sig: "sig", approved_at: new Date().toISOString() });
    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);
    expect(holder.services.get("jellyfin")?.approved).toBe(true);

    store.revokeApproval(hash);
    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);
    expect(holder.services.get("jellyfin")?.approved).toBe(false);
  });

  it("an env-var-only edit does not require re-approval (same projection hash)", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const specA = { image: "jellyfin/jellyfin:10.9.11", devices: ["/dev/dri/renderD128"], env: { TZ: "UTC" } };
    const planGraphA: PlanGraph = { servicePlans: { jellyfin: specA }, routes: [], certRequirements: { mode: "internal-ca", names: [] } };
    const validation = { jellyfin: { tier: "powerful" } };
    const stage = buildGateStage({ store }, holder);

    await stage.run({ desiredState, planGraph: planGraphA, validation } as unknown as ReconcileRunContext);
    const hash = holder.services.get("jellyfin")!.projectionHash;
    store.insertApproval({ projection_hash: hash, service_id: "jellyfin", human_rendering: "x", sig: "sig", approved_at: new Date().toISOString() });

    const specB = { ...specA, env: { TZ: "America/Chicago" } };
    const planGraphB: PlanGraph = { servicePlans: { jellyfin: specB }, routes: [], certRequirements: { mode: "internal-ca", names: [] } };
    await stage.run({ desiredState, planGraph: planGraphB, validation } as unknown as ReconcileRunContext);

    expect(holder.services.get("jellyfin")?.approved).toBe(true); // still approved, no re-approval needed
  });

  it("an image-tag bump on a powerful plan DOES require re-approval (different projection hash)", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const specA = { image: "jellyfin/jellyfin:10.9.11", devices: ["/dev/dri/renderD128"] };
    const planGraphA: PlanGraph = { servicePlans: { jellyfin: specA }, routes: [], certRequirements: { mode: "internal-ca", names: [] } };
    const validation = { jellyfin: { tier: "powerful" } };
    const stage = buildGateStage({ store }, holder);

    await stage.run({ desiredState, planGraph: planGraphA, validation } as unknown as ReconcileRunContext);
    const hash = holder.services.get("jellyfin")!.projectionHash;
    store.insertApproval({ projection_hash: hash, service_id: "jellyfin", human_rendering: "x", sig: "sig", approved_at: new Date().toISOString() });

    const specB = { ...specA, image: "jellyfin/jellyfin:10.9.12" };
    const planGraphB: PlanGraph = { servicePlans: { jellyfin: specB }, routes: [], certRequirements: { mode: "internal-ca", names: [] } };
    await stage.run({ desiredState, planGraph: planGraphB, validation } as unknown as ReconcileRunContext);

    expect(holder.services.get("jellyfin")?.approved).toBe(false); // new hash, not approved
  });

  it("strictApprovals: all gates a purely baseline service too", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc("all"), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = { servicePlans: { kavita: { image: "kavita/kavita:latest" } }, routes: [], certRequirements: { mode: "internal-ca", names: [] } };
    const validation = { kavita: { tier: "baseline" } };

    const stage = buildGateStage({ store }, holder);
    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);

    expect(holder.services.has("kavita")).toBe(true);
    expect(holder.services.get("kavita")?.approved).toBe(false);
  });

  it("strictApprovals: powerful (default) does NOT gate a baseline-only service", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = { servicePlans: { kavita: { image: "kavita/kavita:latest" } }, routes: [], certRequirements: { mode: "internal-ca", names: [] } };
    const validation = { kavita: { tier: "baseline" } };

    const stage = buildGateStage({ store }, holder);
    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);

    expect(holder.services.has("kavita")).toBe(false); // never gated at all
  });

  it("T6.1: a docker.sock bind mount gets the catastrophic-grant banner", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = {
      servicePlans: { evil: { image: "x", mounts: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock", readOnly: false }] } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const validation = { evil: { tier: "powerful" } };

    const stage = buildGateStage({ store }, holder);
    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);

    const banners = holder.services.get("evil")?.banners ?? [];
    expect(banners.length).toBe(1);
    expect(banners[0]).toContain("This grant is equivalent to root on the host");
    expect(banners[0]).toContain("Docker socket");
  });

  it("T6.1: privileged, /dev/mem, and raw disk devices each surface in the catastrophic banner", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = {
      servicePlans: { evil: { image: "x", privileged: true, devices: ["/dev/mem", "/dev/sda1"] } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const validation = { evil: { tier: "powerful" } };

    const stage = buildGateStage({ store }, holder);
    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);

    const banner = holder.services.get("evil")?.banners[0] ?? "";
    expect(banner).toContain("runs privileged");
    expect(banner).toContain("/dev/mem");
    expect(banner).toContain("/dev/sda1");
  });

  it("T6.1: a harmless powerful plan (e.g. just a device grant match) gets no catastrophic banner", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = {
      servicePlans: { jellyfin: { image: "jellyfin/jellyfin:10.9.11", devices: ["/dev/dri/renderD128"] } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const validation = { jellyfin: { tier: "powerful" } };

    const stage = buildGateStage({ store }, holder);
    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);

    expect(holder.services.get("jellyfin")?.banners).toEqual([]);
  });

  it("T6.1/ADR-7: a service document named 'tier1' is force-classified powerful with the self-exposure banner, even if it emits nothing powerful", async () => {
    const store = await makeStore();
    const holder: GateSnapshotHolder = { services: new Map() };
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = { servicePlans: { tier1: { image: "wanfw/tier1:dev" } }, routes: [], certRequirements: { mode: "internal-ca", names: [] } };
    const validation = { tier1: { tier: "baseline" } }; // classifier itself sees nothing powerful

    const stage = buildGateStage({ store }, holder);
    await stage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);

    const gated = holder.services.get("tier1");
    expect(gated?.tier).toBe("powerful");
    expect(gated?.approved).toBe(false); // never auto-approved, never blocked either -- just gated
    expect(gated?.banners.some((b) => b.includes("control plane"))).toBe(true);
  });
});
