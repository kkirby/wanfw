import type { StateStore } from "../state-store/store.js";
import type { Logger } from "../logger.js";
import { hasGrant, matchNamePrefix, type DecodedGrant } from "./scope-matcher.js";
import { getSecret, putSecret } from "../secrets/store.js";

export class CapabilityError extends Error {}

export interface HostApiCallParams {
  invocationId: string;
  pluginId: string;
  method: string;
  args?: unknown;
}

type HostApiHandler = (pluginId: string, args: unknown) => Promise<unknown>;

/**
 * Orchestrator-side dispatch for child-originated host API calls (§6.6).
 * On every call, the plugin's grants are loaded fresh from the store --
 * never trusted from the invocation job payload (invariant #8: "the grants
 * array in an invocation payload is informational only").
 *
 * v1 methods: `state.get/put/delete` (baseline, own plugin_kv namespace --
 * enforced structurally since plugin_kv is always keyed by pluginId, no
 * grant lookup needed), `log.emit` (always allowed), and `secrets.get/put`
 * (powerful, capability-gated -- the first live-call capability check in
 * this dispatcher, T4.1). Further capability-gated methods (dns.*,
 * certs.store, ...) arrive with their owning tasks and reuse the same
 * scope-matcher `hasGrant` helper.
 */
export function buildHostApiDispatcher(store: StateStore, log: Logger, secretsDir: string): (params: unknown) => Promise<unknown> {
  function decodedGrants(pluginId: string): DecodedGrant[] {
    return store.listGrants(pluginId).map((g) => ({ cap: g.cap, scope: JSON.parse(g.scope_json) as Record<string, unknown> }));
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
