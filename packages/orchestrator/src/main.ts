import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { createLogger } from "./logger.js";
import { resolvePaths } from "./paths.js";
import { startHeartbeat, ORCHESTRATOR_VERSION, type HeartbeatState } from "./heartbeat.js";
import { buildStatusSocketRouter, type NudgeState } from "./status-socket.js";
import { buildAdminSocketRouter, type SigningKeyHolder, type PluginConnectionHolder } from "./admin-socket.js";
import { listenOnUnixSocket } from "./uds-server.js";
import { StateStore } from "./state-store/index.js";
import { SigningKeyManager } from "./signing-key.js";
import { AuditLog } from "./audit-log.js";
import { listenPluginSocket } from "./plugin-socket.js";
import type { JsonRpcConnection } from "@wanfw/pluginhost";
import { buildHostApiDispatcher } from "./host-api/index.js";

const log = createLogger("orchestrator");
const paths = resolvePaths();

// Tolerate a missing framework document: this is pre-init state (T5.3 writes
// the real framework doc later). Initialize data dirs so a fresh volume boots
// cleanly.
for (const dir of [paths.stateDir, paths.statusDir, paths.desiredDir, paths.stagingDir, paths.bundlesDir]) {
  mkdirSync(dir, { recursive: true });
}

log.info("orchestrator starting", { version: ORCHESTRATOR_VERSION });

const stateStore = new StateStore(`${paths.stateDir}/state.sqlite3`);
log.info("state store ready", { path: `${paths.stateDir}/state.sqlite3` });

const signingKeyPath = `${paths.stateDir}/signing.key`;
const signingKeyHolder: SigningKeyHolder = {
  manager: await SigningKeyManager.loadOrCreate(signingKeyPath),
  keyPath: signingKeyPath,
};
log.info("signing key ready", { publicKeyPem: signingKeyHolder.manager.getPublicKeyPem().trim() });

const auditLog = new AuditLog(`${paths.stateDir}/audit.jsonl`, () => signingKeyHolder.manager);
log.info("audit log ready", { path: `${paths.stateDir}/audit.jsonl` });

const heartbeatState: HeartbeatState = {
  current: { phase: "pending-init", ts: new Date().toISOString(), version: ORCHESTRATOR_VERSION },
};
const nudgeState: NudgeState = { nudgedAt: null, count: 0 };

const heartbeat = startHeartbeat(paths.statusDir, heartbeatState);

const statusServer: Server = listenOnUnixSocket(
  buildStatusSocketRouter(heartbeatState, nudgeState),
  paths.statusSocketPath,
  0o660,
);
log.info("status socket listening", { path: paths.statusSocketPath });

const pluginConnectionHolder: PluginConnectionHolder = {};

const adminServer: Server = listenOnUnixSocket(
  buildAdminSocketRouter({
    heartbeat: heartbeatState,
    signingKeyHolder,
    store: stateStore,
    auditLog,
    pluginConnectionHolder,
    stagingDir: paths.stagingDir,
    bundlesDir: paths.bundlesDir,
  }),
  paths.adminSocketPath,
  0o600,
);
log.info("admin socket listening", { path: paths.adminSocketPath });

const hostApiDispatch = buildHostApiDispatcher(stateStore, log);
const pluginServer = listenPluginSocket(
  paths.pluginSocketPath,
  log,
  (connection: JsonRpcConnection) => {
    connection.registerMethod("host.call", hostApiDispatch);
    pluginConnectionHolder.connection = connection;
  },
  () => {
    pluginConnectionHolder.connection = undefined;
  },
);
log.info("plugin socket listening", { path: paths.pluginSocketPath });

function shutdown(signal: string): void {
  log.info("shutting down", { signal });
  heartbeat.stop();
  statusServer.close();
  adminServer.close();
  pluginServer.close();
  stateStore.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
