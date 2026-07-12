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
import { loadDesiredState, watchDesiredState, type DesiredState } from "./desired-state/index.js";
import { publishComposedSchema } from "./composed-schema/index.js";
import { resolveDependencies, type FrameworkSpec } from "./dependency-resolution/index.js";

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

// Reconciler (T3.4) will replace this with the real PLAN->VALIDATE->GATE->
// EXECUTE->OBSERVE pipeline; for now the loader is exercised end-to-end so
// desired-state changes are visibly picked up and validation errors surface
// in the logs, with the latest snapshot held for later stages to consume.
let latestDesiredState: DesiredState = { services: new Map(), pluginConfigs: new Map(), errors: [] };

async function reloadDesiredState(): Promise<void> {
  try {
    latestDesiredState = await loadDesiredState(paths.desiredDir);
    if (latestDesiredState.errors.length > 0) {
      log.warn("desired-state reload found document errors", {
        errors: latestDesiredState.errors,
      });
    } else {
      log.info("desired-state reloaded", {
        hasFramework: latestDesiredState.framework !== undefined,
        serviceCount: latestDesiredState.services.size,
        pluginConfigCount: latestDesiredState.pluginConfigs.size,
      });
    }

    // Reconciler (T3.4) will gate PLAN on this; for now dependency
    // resolution runs and surfaces config-time errors in the logs whenever
    // a framework document is present, exercising T3.3 end-to-end.
    if (latestDesiredState.framework) {
      const resolution = await resolveDependencies(
        stateStore,
        paths.bundlesDir,
        latestDesiredState.framework.spec as FrameworkSpec,
      );
      if (!resolution.ok) {
        log.warn("dependency resolution failed", { errors: resolution.errors });
      }
    }
  } catch (err) {
    log.error("desired-state reload failed", { message: (err as Error).message });
  }
}

const desiredStateWatcher = watchDesiredState(paths.desiredDir, () => void reloadDesiredState());
await reloadDesiredState();

await publishComposedSchema(stateStore, paths.bundlesDir, paths.statusDir);
log.info("composed schema published", { path: `${paths.statusDir}/schema.json` });

const statusServer: Server = listenOnUnixSocket(
  buildStatusSocketRouter(heartbeatState, nudgeState, {
    store: stateStore,
    stagingDir: paths.stagingDir,
    statusDir: paths.statusDir,
    onNudge: () => desiredStateWatcher.nudge(),
  }),
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
    statusDir: paths.statusDir,
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
  void desiredStateWatcher.stop();
  statusServer.close();
  adminServer.close();
  pluginServer.close();
  stateStore.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
