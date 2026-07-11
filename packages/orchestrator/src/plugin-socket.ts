import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { JsonRpcConnection } from "@wanfw/pluginhost";
import type { Logger } from "./logger.js";

/**
 * Orchestrator's plugin socket (§2.2, ADR-3): the pluginhost dials in and
 * holds one persistent NDJSON JSON-RPC connection. `host.call` (the
 * capability-gated dispatch for child-originated host API calls) is real
 * grant enforcement from T2.7 onward; this wiring just accepts the
 * connection and gives control-RPC callers (builtins.list, etc., issued
 * by the orchestrator itself in later tasks) something to talk to.
 */
export function listenPluginSocket(
  socketPath: string,
  log: Logger,
  registerMethods: (connection: JsonRpcConnection) => void,
): Server {
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const server = createServer((socket: Socket) => {
    log.info("pluginhost connected", { socketPath });
    const connection = new JsonRpcConnection(socket, socket);
    registerMethods(connection);
    socket.on("close", () => log.info("pluginhost disconnected", { socketPath }));
  });

  server.listen(socketPath);
  return server;
}
