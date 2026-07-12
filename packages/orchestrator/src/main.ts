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
import { watchDesiredState } from "./desired-state/index.js";
import { publishComposedSchema } from "./composed-schema/index.js";
import {
  ReconcileEngine,
  buildLoadStage,
  buildResolveStage,
  buildPlanStage,
  buildValidateStage,
  buildGateStage,
  buildExecuteStage,
  buildObserveStage,
  buildRealPluginInvoker,
  type GateSnapshotHolder,
} from "./reconciler/index.js";
import { buildRealDockerClient } from "./execute/index.js";

const log = createLogger("orchestrator");
const paths = resolvePaths();

// Tolerate a missing framework document: this is pre-init state (T5.3 writes
// the real framework doc later). Initialize data dirs so a fresh volume boots
// cleanly.
for (const dir of [paths.stateDir, paths.statusDir, paths.desiredDir, paths.stagingDir, paths.bundlesDir, paths.secretsDir]) {
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

const pluginConnectionHolder: PluginConnectionHolder = {};
const pluginInvoker = buildRealPluginInvoker({
  store: stateStore,
  auditLog,
  pluginConnectionHolder,
  bundlesDir: paths.bundlesDir,
});

const gateSnapshotHolder: GateSnapshotHolder = { services: new Map() };
const dockerClient = buildRealDockerClient(paths.dockerSocketPath);

// Reconcile engine (T3.4-T3.9): level-triggered, single-flight, coalescing.
// Every stage is real now (T3.1/T3.3/T3.5-T3.9) -- load, resolve, plan,
// validate, gate, execute, observe -- the full pipeline shape from §7.
const reconcileEngine = new ReconcileEngine({
  stages: [
    buildLoadStage({ desiredDir: paths.desiredDir, bundlesDir: paths.bundlesDir, store: stateStore }),
    buildResolveStage({ desiredDir: paths.desiredDir, bundlesDir: paths.bundlesDir, store: stateStore }),
    buildPlanStage({ invokePlugin: pluginInvoker }),
    buildValidateStage({ store: stateStore }),
    buildGateStage({ store: stateStore }, gateSnapshotHolder),
    buildExecuteStage({ store: stateStore, docker: dockerClient, proxycfgDir: paths.proxycfgDir }),
    buildObserveStage({ store: stateStore, docker: dockerClient, statusDir: paths.statusDir }),
  ],
  log,
  onOutcome: (outcome) => {
    heartbeatState.current = {
      phase: outcome.phase,
      ts: outcome.completedAt,
      version: heartbeatState.current.version,
      lastError: outcome.lastError, // cleared (undefined) on a successful outcome, not carried over
    };
  },
});

const desiredStateWatcher = watchDesiredState(paths.desiredDir, () => void reconcileEngine.trigger("desired-state-change"));
await reconcileEngine.trigger("boot");

// 60s timer trigger (§7): catches drift the watcher might miss (e.g. some
// mount types don't propagate inotify events reliably) and will eventually
// pick up cert-renewal-adjacent time-based conditions once T4.6 exists.
const timerTrigger = setInterval(() => void reconcileEngine.trigger("timer"), 60_000);

await publishComposedSchema(stateStore, paths.bundlesDir, paths.statusDir);
log.info("composed schema published", { path: `${paths.statusDir}/schema.json` });

const statusServer: Server = listenOnUnixSocket(
  buildStatusSocketRouter(heartbeatState, nudgeState, {
    store: stateStore,
    stagingDir: paths.stagingDir,
    statusDir: paths.statusDir,
    secretsDir: paths.secretsDir,
    gateSnapshotHolder,
    onNudge: () => void reconcileEngine.trigger("nudge"),
  }),
  paths.statusSocketPath,
  0o660,
);
log.info("status socket listening", { path: paths.statusSocketPath });

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
    secretsDir: paths.secretsDir,
    gateSnapshotHolder,
    onApprovalChange: () => void reconcileEngine.trigger("plan-approve"),
  }),
  paths.adminSocketPath,
  0o600,
);
log.info("admin socket listening", { path: paths.adminSocketPath });

const hostApiDispatch = buildHostApiDispatcher(stateStore, log, paths.secretsDir);
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
  clearInterval(timerTrigger);
  void desiredStateWatcher.stop();
  statusServer.close();
  adminServer.close();
  pluginServer.close();
  stateStore.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
