import type { StateStore } from "../state-store/store.js";
import type { Logger } from "../logger.js";
import { hasGrant, matchNamePrefix, matchZone, type DecodedGrant } from "./scope-matcher.js";
import { getSecret, putSecret } from "../secrets/store.js";
import type { FrameworkRolesHolder } from "../reconciler/core-stages.js";
import type { PluginInvoker } from "../reconciler/plan-stage.js";

export class CapabilityError extends Error {}

export interface HostApiCallParams {
  invocationId: string;
  pluginId: string;
  method: string;
  args?: unknown;
}

type HostApiHandler = (pluginId: string, args: unknown) => Promise<unknown>;

export interface HostApiDispatcherDeps {
  store: StateStore;
  log: Logger;
  secretsDir: string;
  /** Framework role bindings (§5.3), read live so the T4.3 DNS broker can find the bound dnsProvider without threading desired state through this module. */
  rolesHolder: FrameworkRolesHolder;
  /** Reused from T3.5's PLAN stage wiring -- the broker invokes the bound dns-provider plugin's `dns.apply` task through the exact same real pluginhost connection. */
  pluginInvoker: PluginInvoker;
}

/**
 * Orchestrator-side dispatch for child-originated host API calls (§6.6).
 * On every call, the plugin's grants are loaded fresh from the store --
 * never trusted from the invocation job payload (invariant #8: "the grants
 * array in an invocation payload is informational only").
 *
 * v1 methods: `state.get/put/delete` (baseline, own plugin_kv namespace --
 * enforced structurally since plugin_kv is always keyed by pluginId, no
 * grant lookup needed), `log.emit` (always allowed), `secrets.get/put`
 * (powerful, capability-gated, T4.1), and `dns.setRecord/deleteRecord`
 * + `dns.query` (T4.3): the DNS broker. `dns.setRecord`/`deleteRecord` are
 * capability-gated by `dns.record.write` scoped to the target zone, and
 * **brokered**: the calling plugin (e.g. a cert-issuer) never talks to the
 * dns-provider plugin directly -- there is no such RPC path at all, only
 * this broker, which forwards to the framework's currently bound
 * `dnsProvider` role's `dns.apply` task (§6.6). `dns.query` performs no
 * resolution itself (the calling plugin resolves locally, in its own
 * process, since pluginhost -- unlike the orchestrator -- has real network
 * egress); this call is purely advisory, logging the plugin's own query
 * result for observability, never authoritative over anything.
 */
export function buildHostApiDispatcher(deps: HostApiDispatcherDeps): (params: unknown) => Promise<unknown> {
  const { store, log, secretsDir, rolesHolder, pluginInvoker } = deps;

  function decodedGrants(pluginId: string): DecodedGrant[] {
    return store.listGrants(pluginId).map((g) => ({ cap: g.cap, scope: JSON.parse(g.scope_json) as Record<string, unknown> }));
  }

  async function brokerDnsApply(
    pluginId: string,
    action: "set" | "delete",
    args: { zone: string; record: { type: string; name: string; value: string; ttl?: number } },
  ): Promise<unknown> {
    const { zone, record } = args;
    const grants = decodedGrants(pluginId);
    if (!hasGrant(grants, "dns.record.write", (scope) => matchZone((scope.zones as string[]) ?? [], zone))) {
      throw new CapabilityError(`dns.${action === "set" ? "setRecord" : "deleteRecord"} denied: ${pluginId} has no dns.record.write grant covering zone '${zone}'`);
    }
    const dnsProviderId = rolesHolder.roles.dnsProvider;
    if (!dnsProviderId) {
      throw new CapabilityError("no dnsProvider role is currently bound in the framework document");
    }
    const result = await pluginInvoker(dnsProviderId, "dns.apply", { zone, action, record });
    if (!result.ok) {
      throw new CapabilityError(`dns-provider '${dnsProviderId}' rejected the DNS change: ${result.error?.message ?? "unknown error"}`);
    }
    return result.result ?? {};
  }

  const handlers: Record<string, HostApiHandler> = {
    "state.get": async (pluginId, args) => {
      const { key } = args as { key: string };
      return { value: store.getPluginKv(pluginId, key) ?? null };
    },
    "state.put": async (pluginId, args) => {
      const { key, value } = args as { key: string; value: string };
      store.setPluginKv(pluginId, key, value);
      return {};
    },
    "state.delete": async (pluginId, args) => {
      const { key } = args as { key: string };
      store.deletePluginKv(pluginId, key);
      return {};
    },
    "log.emit": async (pluginId, args) => {
      const { level, msg, fields } = args as { level?: string; msg?: string; fields?: Record<string, unknown> };
      log.info(msg ?? "", { component: "plugin", pluginId, level: level ?? "info", ...fields });
      return {};
    },
    "secrets.get": async (pluginId, args) => {
      const { name } = args as { name: string };
      const grants = decodedGrants(pluginId);
      if (!hasGrant(grants, "secrets.read", (scope) => matchNamePrefix((scope.names as string[]) ?? [], name))) {
        throw new CapabilityError(`secrets.get denied: ${pluginId} has no secrets.read grant covering '${name}'`);
      }
      return { value: getSecret(secretsDir, name) ?? null };
    },
    "secrets.put": async (pluginId, args) => {
      const { name, value } = args as { name: string; value: string };
      const grants = decodedGrants(pluginId);
      if (!hasGrant(grants, "secrets.write", (scope) => matchNamePrefix((scope.names as string[]) ?? [], name))) {
        throw new CapabilityError(`secrets.put denied: ${pluginId} has no secrets.write grant covering '${name}'`);
      }
      putSecret(secretsDir, name, value);
      return {};
    },
    "dns.setRecord": async (pluginId, args) => brokerDnsApply(pluginId, "set", args as never),
    "dns.deleteRecord": async (pluginId, args) => brokerDnsApply(pluginId, "delete", args as never),
    "dns.query": async (pluginId, args) => {
      const { name, type, result } = args as { name: string; type: string; result: unknown };
      log.info(`dns.query (advisory, plugin-resolved): ${name} ${type}`, { component: "plugin", pluginId, result });
      return {};
    },
  };

  return async (params: unknown): Promise<unknown> => {
    const { pluginId, method, args } = params as HostApiCallParams;
    const handler = handlers[method];
    if (!handler) {
      throw new CapabilityError(`unknown host API method: ${method}`);
    }
    return handler(pluginId, args);
  };
}
