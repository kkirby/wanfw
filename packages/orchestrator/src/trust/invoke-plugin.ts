import { randomUUID } from "node:crypto";
import type { StateStore } from "../state-store/store.js";
import type { AuditLog } from "../audit-log.js";
import type { PluginConnectionHolder } from "../admin-socket.js";
import { TrustFlowError } from "./trust-flow.js";

export interface InvokeLimits {
  wallMs: number;
  memMb: number;
  cpuSeconds: number;
}

export interface InvokePluginDeps {
  store: StateStore;
  auditLog: AuditLog;
  pluginConnectionHolder: PluginConnectionHolder;
  bundlesDir: string;
}

export interface InvocationOutcome {
  invocationId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * Manual invocation path for exercising the plugin runtime end to end
 * before the reconciler (T3.x) exists to trigger invocations itself. Also
 * doubles as a genuine operator debugging tool once the reconciler lands.
 */
export async function invokeTrustedPlugin(
  deps: InvokePluginDeps,
  pluginId: string,
  task: string,
  input: unknown,
  limits: InvokeLimits,
): Promise<InvocationOutcome> {
  const live = deps.store.listTrustRecords().filter((r) => r.plugin_id === pluginId);
  if (live.length === 0) {
    throw new TrustFlowError(`plugin ${pluginId} is not trusted`);
  }
  const latest = live[live.length - 1]!;
  const bundleDir = `${deps.bundlesDir}/${latest.sha256}`;

  const connection = deps.pluginConnectionHolder.connection;
  if (!connection) {
    throw new Error("pluginhost unreachable");
  }

  const invocationId = randomUUID();

  try {
    const result = (await connection.call("invoke", {
      invocationId,
      pluginId,
      bundleHash: latest.sha256,
      bundleDir,
      task,
      input,
      limits,
    })) as InvocationOutcome;

    deps.auditLog.append({
      type: "plugin.invoke",
      details: { pluginId, task, ok: result.ok, ...(result.error ? { error: result.error } : {}) },
    });
    return result;
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("bundle hash mismatch")) {
      deps.auditLog.append({
        type: "plugin.invoke.refused",
        details: { pluginId, task, reason: "hash_mismatch", message },
      });
    }
    throw err;
  }
}
