import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { createLogger } from "./logger.js";
import { resolvePaths } from "./paths.js";
import { startHeartbeat, ORCHESTRATOR_VERSION, type HeartbeatState } from "./heartbeat.js";
import { buildStatusSocketRouter, type NudgeState } from "./status-socket.js";
import { buildAdminSocketRouter } from "./admin-socket.js";
import { listenOnUnixSocket } from "./uds-server.js";

const log = createLogger("orchestrator");
const paths = resolvePaths();

// Tolerate a missing framework document: this is pre-init state (T5.3 writes
// the real framework doc later). Initialize data dirs so a fresh volume boots
// cleanly.
for (const dir of [paths.stateDir, paths.statusDir, paths.desiredDir]) {
  mkdirSync(dir, { recursive: true });
}

log.info("orchestrator starting", { version: ORCHESTRATOR_VERSION });

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

const adminServer: Server = listenOnUnixSocket(
  buildAdminSocketRouter(heartbeatState),
  paths.adminSocketPath,
  0o600,
);
log.info("admin socket listening", { path: paths.adminSocketPath });

function shutdown(signal: string): void {
  log.info("shutting down", { signal });
  heartbeat.stop();
  statusServer.close();
  adminServer.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
