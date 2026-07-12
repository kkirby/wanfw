import type { StateStore } from "../state-store/store.js";
import type { Grant } from "./validate-plan.js";

/**
 * Loads a plugin's grants fresh from the store for validation (invariant
 * #8: the grants array in an invocation payload is informational only,
 * the store is authoritative). An untrusted or revoked plugin has zero
 * live grants, so every capability-gated field on its plan fails closed.
 */
export function loadGrantsForPlugin(store: StateStore, pluginId: string): Grant[] {
  return store.listGrants(pluginId).map((row) => ({
    cap: row.cap,
    scope: JSON.parse(row.scope_json) as Record<string, unknown>,
  }));
}
