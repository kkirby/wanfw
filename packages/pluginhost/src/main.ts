import { createConnection, type Socket } from "node:net";
import { mkdirSync } from "node:fs";
import { JsonRpcConnection } from "./jsonrpc.js";
import { registerSupervisorMethods } from "./supervisor.js";
import { hashBundleDir } from "@wanfw/core-schemas";

function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), component: "pluginhost", ...fields })}\n`);
}

const PLUGIN_SOCKET_PATH = process.env.WANFW_PLUGIN_SOCKET_PATH ?? "/run/wanfw/orch-plugin.sock";
const BUILTINS_DIR = process.env.WANFW_BUILTINS_DIR ?? "/app/builtins";

log({ level: "info", msg: "pluginhost starting" });
mkdirSync(BUILTINS_DIR, { recursive: true });

let attempts = 0;
let connection: JsonRpcConnection | undefined;
let socket: Socket | undefined;
let shuttingDown = false;

function dial(): void {
  attempts += 1;
  socket = createConnection(PLUGIN_SOCKET_PATH);

  socket.on("connect", () => {
    attempts = 0;
    log({ level: "info", msg: "connected to orchestrator plugin socket", path: PLUGIN_SOCKET_PATH });
    connection = new JsonRpcConnection(socket!, socket!);
    registerSupervisorMethods(connection, {
      builtinsDir: BUILTINS_DIR,
      hashBundleDirFn: hashBundleDir,
      hostApiHandler: (params) => connection!.call("host.call", params),
    });
  });

  socket.on("error", () => {
    // ENOENT/ECONNREFUSED while the orchestrator hasn't listened yet, or the
    // connection dropped. Reconnect below; only log every 10th attempt to
    // avoid flooding stdout during startup ordering races.
    if (attempts % 10 === 1) {
      log({ level: "warn", msg: "plugin socket unreachable, retrying", path: PLUGIN_SOCKET_PATH, attempts });
    }
  });

  socket.on("close", () => {
    connection = undefined;
    if (!shuttingDown) {
      setTimeout(dial, 1000);
    }
  });
}

dial();

function shutdown(signal: string): void {
  log({ level: "info", msg: "shutting down", signal });
  shuttingDown = true;
  socket?.destroy();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
