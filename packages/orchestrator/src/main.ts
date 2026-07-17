import { mkdirSync, existsSync, writeFileSync } from "node:fs";
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
  buildRenewalStage,
  buildRealPluginInvoker,
  type GateSnapshotHolder,
  type FrameworkRolesHolder,
} from "./reconciler/index.js";
import { buildRealDockerClient } from "./execute/index.js";
import { currentCertPaths, listCerts, readRenewalState, writeRenewalState } from "./certs/store.js";

const log = createLogger("orchestrator");
const paths = resolvePaths();

// Tolerate a missing framework document: this is pre-init state (T5.3 writes
// the real framework doc later). Initialize data dirs so a fresh volume boots
// cleanly.
for (const dir of [paths.stateDir, paths.statusDir, paths.desiredDir, paths.stagingDir, paths.bundlesDir, paths.secretsDir, paths.certsDir, paths.proxycfgDir]) {
  mkdirSync(dir, { recursive: true });
}

// A placeholder Caddyfile, written unconditionally at boot if none exists
// yet (T4.7 fix, found by live verification): Docker seeds a genuinely
// *empty* named volume from whichever container mounts it first, copying
// in that image's own content at the mount path, owned by that image's own
// uid. An empty directory (just `mkdirSync` above, zero regular files)
// still counts as empty for this purpose -- if the proxy (caddy:2)
// container's read-only mount happens to be created before the
// orchestrator ever writes an actual file into `proxycfgDir`, the volume
// gets seeded with Caddy's own default sample config instead, owned by
// Caddy's uid, and every later orchestrator write fails with EACCES
// forever after (EXECUTE creates the proxy container before it ever
// writes/reloads its config, since the very first reload needs a running
// container to `docker exec` into). Writing one real file here, at boot --
// always before EXECUTE could possibly run -- keeps the volume non-empty
// from the start, so Docker's copy-up seeding never triggers regardless of
// container creation order. EXECUTE overwrites this with the real rendered
// config on its first pass; content doesn't matter, only that a real file
// with real (orchestrator) ownership exists first.
const placeholderCaddyfile = `${paths.proxycfgDir}/Caddyfile`;
if (!existsSync(placeholderCaddyfile)) {
  writeFileSync(placeholderCaddyfile, ":443, :80 {\n\trespond 404\n}\n");
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
const rolesHolder: FrameworkRolesHolder = { roles: {} };

// Reconcile engine (T3.4-T3.9): level-triggered, single-flight, coalescing.
// Every stage is real now (T3.1/T3.3/T3.5-T3.9) -- load, resolve, plan,
// validate, gate, execute, observe -- the full pipeline shape from §7.
const reconcileEngine = new ReconcileEngine({
  stages: [
    buildLoadStage({ desiredDir: paths.desiredDir, bundlesDir: paths.bundlesDir, store: stateStore, rolesHolder, log }),
    buildResolveStage({ desiredDir: paths.desiredDir, bundlesDir: paths.bundlesDir, store: stateStore }),
    buildPlanStage({ invokePlugin: pluginInvoker, lookupCertPaths: (name) => currentCertPaths(paths.certsDir, name) }),
    buildRenewalStage({
      invokePlugin: pluginInvoker,
      rolesHolder,
      readRenewalState: (name) => readRenewalState(paths.certsDir, name),
      writeRenewalState: (name, state) => writeRenewalState(paths.certsDir, name, state),
      readCertMeta: (name) => {
        const entry = listCerts(paths.certsDir).find((c) => c.name === name);
        return entry?.meta ? { storedAt: entry.meta.storedAt, names: entry.meta.names } : undefined;
      },
      onCertChange: () => void reconcileEngine.trigger("cert-renewed"),
    }),
    buildValidateStage({ store: stateStore }),
    buildGateStage({ store: stateStore }, gateSnapshotHolder),
    buildExecuteStage({
      store: stateStore,
      docker: dockerClient,
      proxycfgDir: paths.proxycfgDir,
      certsVolumeName: paths.certsVolumeName,
      proxycfgVolumeName: paths.proxycfgVolumeName,
    }),
    buildObserveStage({
      store: stateStore,
      docker: dockerClient,
      statusDir: paths.statusDir,
      readCertMeta: (name) => {
        const entry = listCerts(paths.certsDir).find((c) => c.name === name);
        return entry?.meta ? { storedAt: entry.meta.storedAt, names: entry.meta.names } : undefined;
      },
    }),
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
    certsDir: paths.certsDir,
    gateSnapshotHolder,
    auditLog,
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
    certsDir: paths.certsDir,
    gateSnapshotHolder,
    onApprovalChange: () => void reconcileEngine.trigger("plan-approve"),
    onCertChange: () => void reconcileEngine.trigger("cert-rollback"),
    onFrameworkChange: () => void reconcileEngine.trigger("framework-set"),
    docker: dockerClient,
    // Matches dockerode's own default (buildRealDockerClient passes
    // paths.dockerSocketPath straight through to `new Docker({socketPath})`,
    // which falls back to this exact path itself when undefined) -- the
    // doctor check needs a real path string to `existsSync` against, not
    // "let the client library figure it out."
    dockerSocketPath: paths.dockerSocketPath ?? "/var/run/docker.sock",
    probeNetwork: (mode, parent) => dockerClient.probeMacvlan(parent),
  }),
  paths.adminSocketPath,
  0o600,
);
log.info("admin socket listening", { path: paths.adminSocketPath });

const hostApiDispatch = buildHostApiDispatcher({
  store: stateStore,
  log,
  secretsDir: paths.secretsDir,
  certsDir: paths.certsDir,
  bundlesDir: paths.bundlesDir,
  rolesHolder,
  pluginInvoker,
  onCertChange: () => void reconcileEngine.trigger("cert-store"),
  probeNetwork: (mode, parent) => dockerClient.probeMacvlan(parent),
});
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
