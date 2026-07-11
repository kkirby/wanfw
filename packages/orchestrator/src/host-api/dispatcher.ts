import type { StateStore } from "../state-store/store.js";
import type { Logger } from "../logger.js";

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
 * grant lookup needed) and `log.emit` (always allowed). Capability-gated
 * methods (secrets.*, dns.*, certs.store, ...) arrive with their owning
 * tasks (T4.x) and reuse the scope-matcher from this same package.
 */
export function buildHostApiDispatcher(store: StateStore, log: Logger): (params: unknown) => Promise<unknown> {
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
