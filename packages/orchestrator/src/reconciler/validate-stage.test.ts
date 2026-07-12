import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state-store/store.js";
import { buildValidateStage } from "./validate-stage.js";
import type { DesiredState, LoadedDocument } from "../desired-state/index.js";
import type { PlanGraph } from "./plan-stage.js";
import type { ReconcileRunContext } from "./types.js";

function serviceDoc(id: string, image: string): LoadedDocument {
  return {
    kind: "Service",
    id,
    spec: {
      deploy: { plugin: "deploy-docker", image },
      expose: { hostname: id, backendPort: 8080, backendProtocol: "http" },
    },
    schemaVersion: 1,
    sourcePath: `services/${id}.json`,
  };
}

describe("VALIDATE stage", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rm(d, { recursive: true, force: true }).catch(() => {}));
  });

  async function makeStore(): Promise<StateStore> {
    const dbDir = await mkdtemp(join(tmpdir(), "wanfw-validatestage-"));
    dirs.push(dbDir);
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    return store;
  }

  it("passes through when there is no plan graph yet", async () => {
    const store = await makeStore();
    const stage = buildValidateStage({ store });
    const result = await stage.run({ desiredState: { services: new Map(), pluginConfigs: new Map(), errors: [] } });
    expect(result.ok).toBe(true);
  });

  it("passes a baseline plan for a plugin with only an image.pull grant", async () => {
    const store = await makeStore();
    store.insertGrant({
      plugin_id: "deploy-docker",
      cap: "docker.image.pull",
      scope_json: JSON.stringify({ repos: ["*"] }),
      sig: "sig",
      created_at: new Date().toISOString(),
    });

    const desiredState: DesiredState = {
      services: new Map([["jellyfin", serviceDoc("jellyfin", "jellyfin/jellyfin:10.9.11")]]),
      pluginConfigs: new Map(),
      errors: [],
    };
    const planGraph: PlanGraph = {
      servicePlans: { jellyfin: { image: "jellyfin/jellyfin:10.9.11" } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };

    const stage = buildValidateStage({ store });
    const ctx: ReconcileRunContext = { desiredState, planGraph };
    const result = await stage.run(ctx);

    expect(result.ok).toBe(true);
    const validation = ctx.validation as Record<string, { tier: string }>;
    expect(validation.jellyfin?.tier).toBe("baseline");
  });

  it("fails the stage when a service's plan touches a device outside its grant's scope (the confused-deputy case, end to end)", async () => {
    const store = await makeStore();
    store.insertGrant({
      plugin_id: "deploy-docker",
      cap: "docker.image.pull",
      scope_json: JSON.stringify({ repos: ["*"] }),
      sig: "sig",
      created_at: new Date().toISOString(),
    });
    store.insertGrant({
      plugin_id: "deploy-docker",
      cap: "docker.device",
      scope_json: JSON.stringify({ paths: ["/dev/dri/*"] }),
      sig: "sig",
      created_at: new Date().toISOString(),
    });

    const desiredState: DesiredState = {
      services: new Map([["jellyfin", serviceDoc("jellyfin", "jellyfin/jellyfin:10.9.11")]]),
      pluginConfigs: new Map(),
      errors: [],
    };
    const planGraph: PlanGraph = {
      // deploy-docker is trusted and honestly reflects config that asks for
      // /dev/sda -- outside its granted device scope.
      servicePlans: { jellyfin: { image: "jellyfin/jellyfin:10.9.11", devices: ["/dev/sda"] } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };

    const stage = buildValidateStage({ store });
    const result = await stage.run({ desiredState, planGraph });

    expect(result.ok).toBe(false);
    expect(result.error?.stage).toBe("validate");
    expect(result.error?.plugin).toBe("deploy-docker");
    expect(result.error?.message).toMatch(/\/dev\/sda/);
  });

  it("grants are re-fetched from the store, not trusted from any payload -- revoking mid-run changes the outcome", async () => {
    const store = await makeStore();
    const grantId = store.insertGrant({
      plugin_id: "deploy-docker",
      cap: "docker.image.pull",
      scope_json: JSON.stringify({ repos: ["*"] }),
      sig: "sig",
      created_at: new Date().toISOString(),
    });

    const desiredState: DesiredState = {
      services: new Map([["jellyfin", serviceDoc("jellyfin", "jellyfin/jellyfin:10.9.11")]]),
      pluginConfigs: new Map(),
      errors: [],
    };
    const planGraph: PlanGraph = {
      servicePlans: { jellyfin: { image: "jellyfin/jellyfin:10.9.11" } },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };

    const stage = buildValidateStage({ store });
    const before = await stage.run({ desiredState, planGraph });
    expect(before.ok).toBe(true);

    store.revokeGrant(grantId);
    const after = await stage.run({ desiredState, planGraph });
    expect(after.ok).toBe(false);
  });
});
