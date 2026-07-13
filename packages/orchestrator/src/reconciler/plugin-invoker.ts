import { invokeTrustedPlugin, type InvokePluginDeps } from "../trust/index.js";
import type { PluginInvoker } from "./plan-stage.js";

/** Real PluginInvoker backed by the actual pluginhost connection (via T2.9's invokeTrustedPlugin). */
export function buildRealPluginInvoker(deps: InvokePluginDeps): PluginInvoker {
  return async (pluginId, task, input) => {
    try {
      const result = await invokeTrustedPlugin(deps, pluginId, task, input, {
        wallMs: 30_000,
        // memMb floor: see wanfwctl's cli.ts for the full rationale (V8
        // startup cost, host-dependent). This is the reconcile pipeline's
        // own real invoker -- every automatic network.plan/deploy.plan/
        // proxy.render/cert.ensure call goes through here, not just manual
        // `wanfwctl plugin invoke` -- so it needed the same 1536MB floor
        // those two call sites already got. cert.ensure (real RSA/EC key
        // generation) is the most likely of the four to actually trip a
        // too-low ceiling, which is exactly what surfaced this: pebble-e2e
        // kept failing in CI even after the CLI/admin-socket fix, because
        // RENEWAL's automatic invocations never went through either of
        // those paths.
        memMb: 1536,
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
