import { invokeTrustedPlugin, type InvokePluginDeps } from "../trust/index.js";
import type { PluginInvoker } from "./plan-stage.js";

/** Real PluginInvoker backed by the actual pluginhost connection (via T2.9's invokeTrustedPlugin). */
export function buildRealPluginInvoker(deps: InvokePluginDeps): PluginInvoker {
  return async (pluginId, task, input) => {
    try {
      const result = await invokeTrustedPlugin(deps, pluginId, task, input, {
        wallMs: 30_000,
        memMb: 768,
        cpuSeconds: 30,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true, result: result.result };
    } catch (err) {
      return { ok: false, error: { code: "invoke_failed", message: (err as Error).message } };
    }
  };
}
