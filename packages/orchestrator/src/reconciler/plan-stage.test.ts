import { describe, expect, it } from "vitest";
import { canonicalJSONStringify, type JsonValue } from "@wanfw/core-schemas";
import { buildPlanStage, type PluginInvoker } from "./plan-stage.js";
import type { DesiredState, LoadedDocument } from "../desired-state/index.js";
import type { ReconcileRunContext } from "./types.js";

function serviceDoc(id: string, hostname: string, backendPort: number): LoadedDocument {
  return {
    kind: "Service",
    id,
    spec: {
      deploy: { plugin: "deploy-docker", image: `${id}/${id}:latest` },
      expose: { hostname, backendPort, backendProtocol: "http" },
    },
    schemaVersion: 1,
    sourcePath: `services/${id}.json`,
  };
}

function frameworkDoc(): LoadedDocument {
  return {
    kind: "Framework",
    id: "framework",
    spec: {
      domain: "example.tld",
      deploymentMode: "subdomain",
      acmeEmail: "ops@example.tld",
      roles: { networkProvider: "network-bridge", proxyEngine: "proxy-caddy" },
    },
    schemaVersion: 1,
    sourcePath: "framework.json",
  };
}

function fakeInvoker(responses: Record<string, unknown>): PluginInvoker {
  return async (pluginId, task) => {
    const key = `${pluginId}:${task}`;
    if (!(key in responses)) {
      return { ok: false, error: { code: "no_fixture", message: `no fake response registered for ${key}` } };
    }
    return { ok: true, result: responses[key] as JsonValue };
  };
}

describe("PLAN stage", () => {
  it("passes through with no plan graph when there is no framework document yet", async () => {
    const stage = buildPlanStage({ invokePlugin: fakeInvoker({}) });
    const ctx: ReconcileRunContext = {
      desiredState: { services: new Map(), pluginConfigs: new Map(), errors: [] } as DesiredState,
    };
    const result = await stage.run(ctx);
    expect(result.ok).toBe(true);
    expect(ctx.planGraph).toBeUndefined();
  });

  it("produces the expected plan object graph for a two-service fixture (snapshot, canonical JSON)", async () => {
    const desiredState: DesiredState = {
      framework: frameworkDoc(),
      services: new Map([
        ["jellyfin", serviceDoc("jellyfin", "jellyfin", 8096)],
        ["kavita", serviceDoc("kavita", "kavita", 5000)],
      ]),
      pluginConfigs: new Map(),
      errors: [],
    };

    const invoker = fakeInvoker({
      "network-bridge:network.plan": {
        resources: [{ kind: "bridge", name: "wanfw_exposure" }],
        endpoint: { kind: "host-ports", ports: [{ container: 443, host: 443 }] },
        properties: { hostIsolated: false, dedicatedL2: false, hairpinCaveat: false },
      },
      "deploy-docker:deploy.plan": { image: "placeholder", mounts: [], devices: [] },
      "proxy-caddy:proxy.render": { caddyfile: "# rendered", reloadDirective: "caddy reload" },
    });

    const stage = buildPlanStage({ invokePlugin: invoker });
    const ctx: ReconcileRunContext = { desiredState };
    const result = await stage.run(ctx);

    expect(result.ok).toBe(true);
    const snapshot = canonicalJSONStringify(ctx.planGraph as unknown as JsonValue);
    expect(snapshot).toMatchInlineSnapshot(
      `"{"certRequirements":{"mode":"internal-ca","names":["jellyfin","kavita"]},"networkPlan":{"endpoint":{"kind":"host-ports","ports":[{"container":443,"host":443}]},"properties":{"dedicatedL2":false,"hairpinCaveat":false,"hostIsolated":false},"resources":[{"kind":"bridge","name":"wanfw_exposure"}]},"proxyRender":{"caddyfile":"# rendered","reloadDirective":"caddy reload"},"routes":[{"backendPort":8096,"backendProtocol":"http","hostname":"jellyfin","serviceId":"jellyfin"},{"backendPort":5000,"backendProtocol":"http","hostname":"kavita","serviceId":"kavita"}],"servicePlans":{"jellyfin":{"devices":[],"image":"placeholder","mounts":[]},"kavita":{"devices":[],"image":"placeholder","mounts":[]}}}"`,
    );
  });

  it("routes are sorted by serviceId regardless of Map insertion order", async () => {
    const desiredState: DesiredState = {
      framework: frameworkDoc(),
      services: new Map([
        ["zeta", serviceDoc("zeta", "zeta", 1000)],
        ["alpha", serviceDoc("alpha", "alpha", 2000)],
      ]),
      pluginConfigs: new Map(),
      errors: [],
    };
    const invoker = fakeInvoker({
      "network-bridge:network.plan": {},
      "deploy-docker:deploy.plan": {},
      "proxy-caddy:proxy.render": {},
    });
    const stage = buildPlanStage({ invokePlugin: invoker });
    const ctx: ReconcileRunContext = { desiredState };
    await stage.run(ctx);

    const graph = ctx.planGraph as { routes: Array<{ serviceId: string }> };
    expect(graph.routes.map((r) => r.serviceId)).toEqual(["alpha", "zeta"]);
  });

  it("fails the stage with a structured, plugin-attributed error when a service's deploy plugin is untrusted", async () => {
    const desiredState: DesiredState = {
      framework: frameworkDoc(),
      services: new Map([["jellyfin", serviceDoc("jellyfin", "jellyfin", 8096)]]),
      pluginConfigs: new Map(),
      errors: [],
    };
    const invoker = fakeInvoker({ "network-bridge:network.plan": {} }); // deploy-docker not registered
    const stage = buildPlanStage({ invokePlugin: invoker });
    const result = await stage.run({ desiredState });

    expect(result.ok).toBe(false);
    expect(result.error?.stage).toBe("plan");
    expect(result.error?.plugin).toBe("deploy-docker");
  });

  it("fails the stage when the bound network-provider's plan task fails", async () => {
    const desiredState: DesiredState = {
      framework: frameworkDoc(),
      services: new Map(),
      pluginConfigs: new Map(),
      errors: [],
    };
    const invoker: PluginInvoker = async () => ({ ok: false, error: { code: "denied", message: "probe declined" } });
    const stage = buildPlanStage({ invokePlugin: invoker });
    const result = await stage.run({ desiredState });

    expect(result.ok).toBe(false);
    expect(result.error?.plugin).toBe("network-bridge");
    expect(result.error?.message).toBe("probe declined");
  });

  it("cert requirements list unique, sorted hostnames (M2 short-circuit to internal-ca)", async () => {
    const desiredState: DesiredState = {
      framework: frameworkDoc(),
      services: new Map([
        ["jellyfin", serviceDoc("jellyfin", "jellyfin", 8096)],
        ["kavita", serviceDoc("kavita", "kavita", 5000)],
      ]),
      pluginConfigs: new Map(),
      errors: [],
    };
    const invoker = fakeInvoker({
      "network-bridge:network.plan": {},
      "deploy-docker:deploy.plan": {},
      "proxy-caddy:proxy.render": {},
    });
    const stage = buildPlanStage({ invokePlugin: invoker });
    const ctx: ReconcileRunContext = { desiredState };
    await stage.run(ctx);

    const graph = ctx.planGraph as { certRequirements: { mode: string; names: string[] } };
    expect(graph.certRequirements).toEqual({ mode: "internal-ca", names: ["jellyfin", "kavita"] });
  });

  it("forwards the looked-up wildcard cert paths to proxy.render when lookupCertPaths finds one (T4.5)", async () => {
    const desiredState: DesiredState = {
      framework: frameworkDoc(),
      services: new Map([["jellyfin", serviceDoc("jellyfin", "jellyfin", 8096)]]),
      pluginConfigs: new Map(),
      errors: [],
    };
    let renderArgs: unknown;
    const invoker: PluginInvoker = async (pluginId, task, args) => {
      if (task === "proxy.render") renderArgs = args;
      return { ok: true, result: {} };
    };
    const stage = buildPlanStage({
      invokePlugin: invoker,
      lookupCertPaths: (name) => (name === "wildcard" ? { certPath: "/data/certs/wildcard/gen-1/fullchain.pem", keyPath: "/data/certs/wildcard/gen-1/key.pem" } : undefined),
    });
    await stage.run({ desiredState });

    expect(renderArgs).toEqual({
      routes: [{ serviceId: "jellyfin", hostname: "jellyfin", backendPort: 8096, backendProtocol: "http" }],
      cert: { certPath: "/data/certs/wildcard/gen-1/fullchain.pem", keyPath: "/data/certs/wildcard/gen-1/key.pem" },
    });
  });

  it("omits cert from proxy.render input when no lookupCertPaths is provided", async () => {
    const desiredState: DesiredState = {
      framework: frameworkDoc(),
      services: new Map([["jellyfin", serviceDoc("jellyfin", "jellyfin", 8096)]]),
      pluginConfigs: new Map(),
      errors: [],
    };
    let renderArgs: unknown;
    const invoker: PluginInvoker = async (pluginId, task, args) => {
      if (task === "proxy.render") renderArgs = args;
      return { ok: true, result: {} };
    };
    const stage = buildPlanStage({ invokePlugin: invoker });
    await stage.run({ desiredState });

    expect((renderArgs as { cert?: unknown }).cert).toBeUndefined();
  });
});
