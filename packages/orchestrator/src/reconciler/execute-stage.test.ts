import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state-store/store.js";
import { FakeDockerClient } from "../execute/fake-docker-client.js";
import { buildExecuteStage } from "./execute-stage.js";
import type { GatedService } from "./gate-stage.js";
import type { DesiredState, LoadedDocument } from "../desired-state/index.js";
import type { PlanGraph } from "./plan-stage.js";
import type { ReconcileRunContext } from "./types.js";

function frameworkDoc(): LoadedDocument {
  return {
    kind: "Framework",
    id: "framework",
    spec: { domain: "example.tld", deploymentMode: "subdomain", acmeEmail: "ops@example.tld", roles: {} },
    schemaVersion: 1,
    sourcePath: "framework.json",
  };
}

describe("EXECUTE stage (T3.8)", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rm(d, { recursive: true, force: true }).catch(() => {}));
  });

  async function makeStore(): Promise<StateStore> {
    const dbDir = await mkdtemp(join(tmpdir(), "wanfw-executestage-"));
    dirs.push(dbDir);
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    return store;
  }

  it("creates network + container on the first reconcile, and every step is a no-op on the second (idempotency)", async () => {
    const store = await makeStore();
    const proxycfgDir = await mkdtemp(join(tmpdir(), "wanfw-proxycfg-"));
    dirs.push(proxycfgDir);
    const docker = new FakeDockerClient();
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = {
      servicePlans: { jellyfin: { image: "jellyfin/jellyfin:10.9.11", env: { TZ: "UTC" } } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const stage = buildExecuteStage({ store, docker, proxycfgDir });

    const ctx1 = { desiredState, planGraph } as unknown as ReconcileRunContext;
    const first = await stage.run(ctx1);
    expect(first.ok).toBe(true);
    expect(docker.containers.has("wanfw_jellyfin")).toBe(true);
    expect(docker.networks.has("wanfw_svc_jellyfin")).toBe(true);
    const firstRows = store.listJournal(ctx1.executedPlanId as string);
    expect(firstRows.some((r) => JSON.parse(r.result).changed === true)).toBe(true);

    const ctx2 = { desiredState, planGraph } as unknown as ReconcileRunContext;
    const second = await stage.run(ctx2);
    expect(second.ok).toBe(true);
    expect(docker.containers.size).toBe(1); // still exactly one, not recreated

    const secondRows = store.listJournal(ctx2.executedPlanId as string);
    expect(secondRows.length).toBeGreaterThan(0);
    for (const row of secondRows) {
      expect(JSON.parse(row.result).changed).toBe(false); // second reconcile is all no-ops
    }
  });

  it("journals every step with (planId, step, result)", async () => {
    const store = await makeStore();
    const proxycfgDir = await mkdtemp(join(tmpdir(), "wanfw-proxycfg-"));
    dirs.push(proxycfgDir);
    const docker = new FakeDockerClient();
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = {
      servicePlans: { jellyfin: { image: "jellyfin/jellyfin:10.9.11" } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const stage = buildExecuteStage({ store, docker, proxycfgDir });
    const ctx = { desiredState, planGraph } as unknown as ReconcileRunContext;
    await stage.run(ctx);

    const planId = ctx.executedPlanId as string;
    expect(planId).toBeTruthy();
    const rows = store.listJournal(planId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.plan_id === planId)).toBe(true);
    expect(rows.some((r) => r.step.startsWith("ensureNetwork"))).toBe(true);
    expect(rows.some((r) => r.step.startsWith("ensureContainer"))).toBe(true);
  });

  it("a service parked by GATE (approved: false) is skipped, journaled, but does not fail the stage", async () => {
    const store = await makeStore();
    const proxycfgDir = await mkdtemp(join(tmpdir(), "wanfw-proxycfg-"));
    dirs.push(proxycfgDir);
    const docker = new FakeDockerClient();
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = {
      servicePlans: { jellyfin: { image: "jellyfin/jellyfin:10.9.11", devices: ["/dev/dri/renderD128"] } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const gateSnapshot = new Map<string, GatedService>([
      ["jellyfin", { serviceId: "jellyfin", tier: "powerful", projectionHash: "h", humanRendering: "x", approved: false }],
    ]);
    const stage = buildExecuteStage({ store, docker, proxycfgDir });
    const result = await stage.run({ desiredState, planGraph, gateSnapshot } as unknown as ReconcileRunContext);

    expect(result.ok).toBe(true);
    expect(docker.containers.has("wanfw_jellyfin")).toBe(false);
  });

  it("an approved service in the gate snapshot proceeds to EXECUTE", async () => {
    const store = await makeStore();
    const proxycfgDir = await mkdtemp(join(tmpdir(), "wanfw-proxycfg-"));
    dirs.push(proxycfgDir);
    const docker = new FakeDockerClient();
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = {
      servicePlans: { jellyfin: { image: "jellyfin/jellyfin:10.9.11", devices: ["/dev/dri/renderD128"] } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const gateSnapshot = new Map<string, GatedService>([
      ["jellyfin", { serviceId: "jellyfin", tier: "powerful", projectionHash: "h", humanRendering: "x", approved: true }],
    ]);
    const stage = buildExecuteStage({ store, docker, proxycfgDir });
    const result = await stage.run({ desiredState, planGraph, gateSnapshot } as unknown as ReconcileRunContext);

    expect(result.ok).toBe(true);
    expect(docker.containers.has("wanfw_jellyfin")).toBe(true);
  });

  it("simulated crash mid-plan (docker error partway through) converges cleanly on the next reconcile", async () => {
    const store = await makeStore();
    const proxycfgDir = await mkdtemp(join(tmpdir(), "wanfw-proxycfg-"));
    dirs.push(proxycfgDir);
    const docker = new FakeDockerClient();
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = {
      servicePlans: { jellyfin: { image: "jellyfin/jellyfin:10.9.11" } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const stage = buildExecuteStage({ store, docker, proxycfgDir });

    // Simulate a "crash": force createContainer to throw once, as if the
    // process died mid-syscall. The stage should fail this run (journal
    // shows the error) without leaving partial in-memory state that blocks
    // the next run.
    const originalCreate = docker.createContainer.bind(docker);
    let calls = 0;
    docker.createContainer = async (options) => {
      calls += 1;
      if (calls === 1) throw new Error("simulated crash mid-createContainer");
      return originalCreate(options);
    };

    const first = await stage.run({ desiredState, planGraph } as unknown as ReconcileRunContext);
    expect(first.ok).toBe(false);
    expect(docker.containers.has("wanfw_jellyfin")).toBe(false);

    const second = await stage.run({ desiredState, planGraph } as unknown as ReconcileRunContext);
    expect(second.ok).toBe(true);
    expect(docker.containers.has("wanfw_jellyfin")).toBe(true);
  });
});
