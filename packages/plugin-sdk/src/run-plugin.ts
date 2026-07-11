import type { Readable, Writable } from "node:stream";
import { JsonRpcConnection } from "@wanfw/pluginhost";
import { HostApiClient } from "./host-client.js";
import type { TaskMap } from "./task-types.js";

export interface RunPluginOptions {
  tasks: TaskMap;
  /** Overridable for tests; defaults to real process stdio. */
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Plugin entrypoint runtime (§6.7). Reads NDJSON JSON-RPC requests on
 * stdin, dispatches to the matching task in `tasks`, and writes the
 * response on stdout. This is the code every plugin's `dist/main.js`
 * calls at module load; the pluginhost spawns exactly this process per
 * invocation (ADR-3) and bridges its stdio to the orchestrator.
 */
export function runPlugin(options: RunPluginOptions): JsonRpcConnection {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  const connection = new JsonRpcConnection(stdin, stdout);
  const host = new HostApiClient(connection);

  for (const [taskName, handler] of Object.entries(options.tasks)) {
    connection.registerMethod(taskName, async (params) => handler(params, host));
  }

  return connection;
}
