import type { DesiredState, LoadedDocument } from "../desired-state/index.js";
import type { JsonValue } from "@wanfw/core-schemas";
import type { NamedStage, ReconcileRunContext, StageResult } from "./types.js";

export interface PluginInvokeResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** Injected so PLAN can be unit-tested without a live pluginhost connection. */
export type PluginInvoker = (pluginId: string, task: string, input: unknown) => Promise<PluginInvokeResult>;

export interface PlanRouteEntry {
  serviceId: string;
  hostname: string;
  backendPort: number;
  backendProtocol: string;
}

export interface CertRequirements {
  /** M2 short-circuit (§7 PLAN note): real ACME derivation lands in T4.x; until then every name is served from Caddy's internal CA. */
  mode: "internal-ca";
  names: string[];
}

export interface CertPaths {
  certPath: string;
  keyPath: string;
}

export interface PlanGraph {
  networkPlan?: unknown;
  servicePlans: Record<string, unknown>;
  routes: PlanRouteEntry[];
  proxyRender?: unknown;
  certRequirements: CertRequirements;
}

export interface PlanStageDeps {
  invokePlugin: PluginInvoker;
  /** Reads the current generation's cert/key paths for a stored cert name, or undefined if none has ever been stored (T4.5). Injected (rather than importing certs/store.js directly) so PLAN stays unit-testable without a real cert volume. */
  lookupCertPaths?: (name: string) => CertPaths | undefined;
}

/** Convention (T4.5): every route is served from one framework-wide cert stored under this name -- cert-letsencrypt-dns01 issues a single SAN cert covering every exposed hostname, matching graph.certRequirements.names. */
export const WILDCARD_CERT_NAME = "wildcard";

function boundDeployPluginId(service: LoadedDocument): string | undefined {
  const deploy = service.spec.deploy as { plugin?: string } | undefined;
  return deploy?.plugin;
}

function serviceExpose(service: LoadedDocument): { hostname: string; backendPort: number; backendProtocol: string } {
  const expose = service.spec.expose as { hostname: string; backendPort: number; backendProtocol: string };
  return expose;
}

/**
 * PLAN stage (§7 PLAN, T3.5): for the framework, invokes the bound
 * network-provider's `network.plan` task; for each service, invokes its
 * deploy plugin's `deploy.plan` task; assembles the route set from every
 * service's expose block; invokes the bound proxy-engine's `proxy.render`
 * task with that route set; derives cert requirements (M2 short-circuits
 * to Caddy's internal CA -- real ACME derivation is T4.x, the seam is this
 * same `certRequirements` shape, unchanged).
 *
 * A missing/untrusted plugin for a *bound role* or a service's declared
 * deploy plugin is a stage failure (nothing can be planned without it); a
 * service naming a deploy plugin that isn't trusted fails the same way,
 * named precisely.
 */
export function buildPlanStage(deps: PlanStageDeps): NamedStage {
  return {
    name: "plan",
    run: async (ctx: ReconcileRunContext): Promise<StageResult> => {
      const desiredState = ctx.desiredState as DesiredState | undefined;
      if (!desiredState?.framework) {
        return { ok: true }; // pre-init state: nothing to plan yet
      }

      const roles = (desiredState.framework.spec.roles as Record<string, string> | undefined) ?? {};
      const graph: PlanGraph = {
        servicePlans: {},
        routes: [],
        certRequirements: { mode: "internal-ca", names: [] },
      };

      const networkProviderId = roles.networkProvider;
      if (networkProviderId) {
        // `parent` rides alongside the ADR-1-typed EndpointRequest fields
        // for a macvlan provider (T5.2): `EndpointRequest` itself is
        // deliberately provider-agnostic (no macvlan-specific field), so
        // this is a structural superset a bridge-type provider simply
        // ignores, sourced from framework.spec.network.macvlan.parent --
        // core's own schema, not a plugin-specific config anchor, since
        // the parent interface is core-relevant (IPAM range sync,
        // T5.1's own core-stages.ts load-time sync, reads the same field).
        const macvlan = (desiredState.framework.spec.network as { macvlan?: { parent?: string } } | undefined)?.macvlan;
        const res = await deps.invokePlugin(networkProviderId, "network.plan", {
          purpose: "shared-proxy",
          ports: [443, 80],
          stableAddress: true,
          ...(macvlan?.parent ? { parent: macvlan.parent } : {}),
        });
        if (!res.ok) {
          return {
            ok: false,
            error: { stage: "plan", plugin: networkProviderId, message: res.error?.message ?? "network.plan failed" },
          };
        }
        graph.networkPlan = res.result;
      }

      for (const service of desiredState.services.values()) {
        const pluginId = boundDeployPluginId(service);
        if (!pluginId) {
          return { ok: false, error: { stage: "plan", plugin: service.id, message: `service ${service.id} has no deploy plugin bound` } };
        }
        const res = await deps.invokePlugin(pluginId, "deploy.plan", {
          service: service.spec as Record<string, JsonValue>,
          context: { serviceId: service.id },
        });
        if (!res.ok) {
          return {
            ok: false,
            error: { stage: "plan", plugin: pluginId, message: res.error?.message ?? `deploy.plan failed for ${service.id}` },
          };
        }
        graph.servicePlans[service.id] = res.result;

        const expose = serviceExpose(service);
        graph.routes.push({
          serviceId: service.id,
          hostname: expose.hostname,
          backendPort: expose.backendPort,
          backendProtocol: expose.backendProtocol,
        });
        graph.certRequirements.names.push(expose.hostname);
      }

      graph.routes.sort((a, b) => a.serviceId.localeCompare(b.serviceId));
      graph.certRequirements.names = [...new Set(graph.certRequirements.names)].sort();

      const proxyEngineId = roles.proxyEngine;
      if (proxyEngineId) {
        const cert = deps.lookupCertPaths?.(WILDCARD_CERT_NAME);
        const res = await deps.invokePlugin(proxyEngineId, "proxy.render", { routes: graph.routes, cert });
        if (!res.ok) {
          return {
            ok: false,
            error: { stage: "plan", plugin: proxyEngineId, message: res.error?.message ?? "proxy.render failed" },
          };
        }
        graph.proxyRender = res.result;
      }

      ctx.planGraph = graph;
      return { ok: true };
    },
  };
}
