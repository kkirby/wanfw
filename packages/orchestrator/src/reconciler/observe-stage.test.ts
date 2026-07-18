import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state-store/store.js";
import { FakeDockerClient } from "../execute/fake-docker-client.js";
import { ensureContainer, ensureNetwork, ensureVolume } from "../execute/ensure.js";
import { buildObserveStage } from "./observe-stage.js";
import type { DesiredState, LoadedDocument } from "../desired-state/index.js";
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

function serviceDoc(id: string, removeVolumesOnDelete = false): LoadedDocument {
  return {
    kind: "Service",
    id,
    spec: {
      deploy: { plugin: "deploy-docker" },
      expose: { hostname: `${id}.example.tld`, backendPort: 80, backendProtocol: "http", removeVolumesOnDelete },
    },
    schemaVersion: 1,
    sourcePath: `services/${id}.json`,
  };
}

describe("OBSERVE stage (T3.9)", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rm(d, { recursive: true, force: true }).catch(() => {}));
  });

  async function makeStore(): Promise<StateStore> {
    const dbDir = await mkdtemp(join(tmpdir(), "wanfw-observestage-"));
    dirs.push(dbDir);
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    return store;
  }

  async function makeStatusDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-observestatus-"));
    dirs.push(dir);
    return dir;
  }

  it("removing a service from desired state GCs every labeled object for it: container, network, and (opted-in) volume", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();

    await ensureNetwork(docker, "wanfw_svc_kavita", { service: "kavita", plan: "p0" });
    await ensureVolume(docker, "wanfw_kavita_config", { service: "kavita", plan: "p0", removeVolumesOnDelete: true });
    await ensureContainer(docker, "wanfw_kavita", { image: "kavita/kavita:latest" }, { service: "kavita", plan: "p0" });

    // kavita no longer in desired state -- simulates the service doc being deleted.
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({ store, docker, statusDir });
    const result = await stage.run({ desiredState } as unknown as ReconcileRunContext);

    expect(result.ok).toBe(true);
    expect(docker.containers.has("wanfw_kavita")).toBe(false);
    expect(docker.networks.has("wanfw_svc_kavita")).toBe(false);
    expect(docker.volumes.has("wanfw_kavita_config")).toBe(false);
  });

  it("volumes survive GC by default (removeVolumesOnDelete not set)", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();

    await ensureNetwork(docker, "wanfw_svc_kavita", { service: "kavita", plan: "p0" });
    await ensureVolume(docker, "wanfw_kavita_config", { service: "kavita", plan: "p0" }); // no removeVolumesOnDelete
    await ensureContainer(docker, "wanfw_kavita", { image: "kavita/kavita:latest" }, { service: "kavita", plan: "p0" });

    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({ store, docker, statusDir });
    await stage.run({ desiredState } as unknown as ReconcileRunContext);

    expect(docker.containers.has("wanfw_kavita")).toBe(false); // container still GC'd
    expect(docker.networks.has("wanfw_svc_kavita")).toBe(false); // network still GC'd
    expect(docker.volumes.has("wanfw_kavita_config")).toBe(true); // volume data kept
  });

  it("unlabeled bystander containers are never touched by GC", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();
    docker.addBystanderContainer("some-other-app");

    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({ store, docker, statusDir });
    await stage.run({ desiredState } as unknown as ReconcileRunContext);

    expect(docker.containers.has("some-other-app")).toBe(true);
  });

  it("a core-authority object (wanfw.core=true, no wanfw.service label -- e.g. the managed proxy, §8.4/ADR-9) survives GC every pass", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();
    await ensureNetwork(docker, "wanfw_exposure", { plan: "p0", core: true });
    await ensureContainer(docker, "wanfw-proxy", { image: "caddy:2" }, { plan: "p0", core: true });

    // No services in desired state at all -- if the proxy were mistakenly
    // service-scoped it would be GC'd here, since GC only spares objects
    // whose wanfw.service label matches something in desiredServiceIds.
    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({ store, docker, statusDir });
    await stage.run({ desiredState } as unknown as ReconcileRunContext);

    expect(docker.containers.has("wanfw-proxy")).toBe(true);
    expect(docker.networks.has("wanfw_exposure")).toBe(true);
  });

  it("a still-desired service is left alone (zero GC) and gets a live status doc", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();
    await ensureContainer(docker, "wanfw_kavita", { image: "kavita/kavita:latest" }, { service: "kavita", plan: "p0" });

    const services = new Map([["kavita", serviceDoc("kavita")]]);
    const desiredState: DesiredState = { framework: frameworkDoc(), services, pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({ store, docker, statusDir });
    await stage.run({ desiredState } as unknown as ReconcileRunContext);

    expect(docker.containers.has("wanfw_kavita")).toBe(true);
    const raw = await readFile(join(statusDir, "services", "kavita.json"), "utf8");
    const doc = JSON.parse(raw);
    expect(doc.serviceId).toBe("kavita");
    expect(doc.endpoints).toEqual(["kavita.example.tld"]);
    expect(doc.certNotAfter).toBeNull();
  });

  it("projects certNotAfter from the wildcard cert's storedAt + 90 days when the service's hostname is covered", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();
    await ensureContainer(docker, "wanfw_kavita", { image: "kavita/kavita:latest" }, { service: "kavita", plan: "p0" });

    const services = new Map([["kavita", serviceDoc("kavita")]]);
    const desiredState: DesiredState = { framework: frameworkDoc(), services, pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({
      store,
      docker,
      statusDir,
      readCertMeta: () => ({ storedAt: "2026-04-01T00:00:00.000Z", names: ["kavita.example.tld"] }),
    });
    await stage.run({ desiredState } as unknown as ReconcileRunContext);

    const raw = await readFile(join(statusDir, "services", "kavita.json"), "utf8");
    const doc = JSON.parse(raw);
    // 2026-04-01 + 90 days
    expect(doc.certNotAfter).toBe("2026-06-30T00:00:00.000Z");
  });

  it("does not project certNotAfter for a service whose hostname the current cert doesn't cover", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();
    await ensureContainer(docker, "wanfw_kavita", { image: "kavita/kavita:latest" }, { service: "kavita", plan: "p0" });

    const services = new Map([["kavita", serviceDoc("kavita")]]);
    const desiredState: DesiredState = { framework: frameworkDoc(), services, pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({
      store,
      docker,
      statusDir,
      readCertMeta: () => ({ storedAt: "2026-04-01T00:00:00.000Z", names: ["other.example.tld"] }),
    });
    await stage.run({ desiredState } as unknown as ReconcileRunContext);

    const raw = await readFile(join(statusDir, "services", "kavita.json"), "utf8");
    expect(JSON.parse(raw).certNotAfter).toBeNull();
  });

  it("propagates a framework-wide renewal degradedReason as this service's own lastError when its hostname is covered", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();
    await ensureContainer(docker, "wanfw_kavita", { image: "kavita/kavita:latest" }, { service: "kavita", plan: "p0" });

    const services = new Map([["kavita", serviceDoc("kavita")]]);
    const desiredState: DesiredState = { framework: frameworkDoc(), services, pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({ store, docker, statusDir });
    const ctx = {
      desiredState,
      planGraph: { servicePlans: {}, routes: [], certRequirements: { mode: "internal-ca", names: ["kavita.example.tld"] } },
      degradedReason: { stage: "renewal", message: "cert 'wildcard' has fewer than 7 days remaining; last renewal attempt failed: rate limited" },
    } as unknown as ReconcileRunContext;
    await stage.run(ctx);

    const raw = await readFile(join(statusDir, "services", "kavita.json"), "utf8");
    const doc = JSON.parse(raw);
    expect(doc.lastError?.message).toContain("rate limited");
  });

  it("does not propagate a renewal degradedReason to a service whose hostname isn't among the required names", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();
    await ensureContainer(docker, "wanfw_kavita", { image: "kavita/kavita:latest" }, { service: "kavita", plan: "p0" });

    const services = new Map([["kavita", serviceDoc("kavita")]]);
    const desiredState: DesiredState = { framework: frameworkDoc(), services, pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({ store, docker, statusDir });
    const ctx = {
      desiredState,
      planGraph: { servicePlans: {}, routes: [], certRequirements: { mode: "internal-ca", names: ["other.example.tld"] } },
      degradedReason: { stage: "renewal", message: "cert 'wildcard' has fewer than 7 days remaining" },
    } as unknown as ReconcileRunContext;
    await stage.run(ctx);

    const raw = await readFile(join(statusDir, "services", "kavita.json"), "utf8");
    expect(JSON.parse(raw).lastError).toBeUndefined();
  });

  it("does not propagate a degradedReason from a non-renewal stage as a service's lastError", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();
    await ensureContainer(docker, "wanfw_kavita", { image: "kavita/kavita:latest" }, { service: "kavita", plan: "p0" });

    const services = new Map([["kavita", serviceDoc("kavita")]]);
    const desiredState: DesiredState = { framework: frameworkDoc(), services, pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({ store, docker, statusDir });
    const ctx = {
      desiredState,
      planGraph: { servicePlans: {}, routes: [], certRequirements: { mode: "internal-ca", names: ["kavita.example.tld"] } },
      degradedReason: { stage: "plan", plugin: "network-macvlan", message: "unrelated plan-stage problem" },
    } as unknown as ReconcileRunContext;
    await stage.run(ctx);

    const raw = await readFile(join(statusDir, "services", "kavita.json"), "utf8");
    expect(JSON.parse(raw).lastError).toBeUndefined();
  });

  it("a service parked pending approval gets phase 'pending-approval' in its status doc", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();

    const services = new Map([["kavita", serviceDoc("kavita")]]);
    const desiredState: DesiredState = { framework: frameworkDoc(), services, pluginConfigs: new Map(), errors: [] };
    const gateSnapshot = new Map([
      ["kavita", { serviceId: "kavita", tier: "powerful" as const, projectionHash: "h", humanRendering: "x", approved: false, banners: [] }],
    ]);
    const stage = buildObserveStage({ store, docker, statusDir });
    await stage.run({ desiredState, gateSnapshot } as unknown as ReconcileRunContext);

    const raw = await readFile(join(statusDir, "services", "kavita.json"), "utf8");
    expect(JSON.parse(raw).phase).toBe("pending-approval");
  });

  it("journals every GC removal", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();
    await ensureContainer(docker, "wanfw_kavita", { image: "kavita/kavita:latest" }, { service: "kavita", plan: "p0" });

    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const stage = buildObserveStage({ store, docker, statusDir });
    await stage.run({ desiredState } as unknown as ReconcileRunContext);

    const rows = store.listJournal("observe");
    expect(rows.some((r) => r.step === "gc:container:wanfw_kavita")).toBe(true);
  });

  it("removes the stale status doc for a service that left desired state", async () => {
    const store = await makeStore();
    const statusDir = await makeStatusDir();
    const docker = new FakeDockerClient();
    await ensureContainer(docker, "wanfw_kavita", { image: "kavita/kavita:latest" }, { service: "kavita", plan: "p0" });

    const stageWithService = buildObserveStage({ store, docker, statusDir });
    const services = new Map([["kavita", serviceDoc("kavita")]]);
    await stageWithService.run({
      desiredState: { framework: frameworkDoc(), services, pluginConfigs: new Map(), errors: [] },
    } as unknown as ReconcileRunContext);
    await expect(readFile(join(statusDir, "services", "kavita.json"), "utf8")).resolves.toBeDefined();

    // kavita removed from desired state on the next reconcile
    await stageWithService.run({
      desiredState: { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] },
    } as unknown as ReconcileRunContext);

    await expect(readFile(join(statusDir, "services", "kavita.json"), "utf8")).rejects.toThrow();
  });
});
