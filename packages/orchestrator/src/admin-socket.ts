import { JsonUdsRouter } from "./uds-server.js";
import type { HeartbeatState } from "./heartbeat.js";
import { SigningKeyManager } from "./signing-key.js";
import type { StateStore } from "./state-store/store.js";
import type { AuditLog } from "./audit-log.js";
import type { JsonRpcConnection } from "@wanfw/pluginhost";
import {
  listStagedBundles,
  trustStagedBundle,
  trustBuiltin,
  untrustPlugin,
  TrustFlowError,
  type TrustFlowDeps,
  invokeTrustedPlugin,
} from "./trust/index.js";
import { publishComposedSchema } from "./composed-schema/index.js";
import { canonicalApprovalPayload } from "./signing-key.js";
import type { GateSnapshotHolder } from "./reconciler/index.js";
import { putSecret, unsetSecret, listSecrets } from "./secrets/store.js";
import { listCerts, rollbackCert } from "./certs/store.js";
import { validateEnvelope } from "./desired-state/index.js";
import type { DockerClient } from "./execute/docker-client.js";
import { runDoctorChecks } from "./doctor.js";

/** Mutable holder so `key import`/`key rotate` can swap the live manager instance. */
export interface SigningKeyHolder {
  manager: SigningKeyManager;
  keyPath: string;
}

/** Mutable holder for the (at most one) pluginhost's persistent connection. */
export interface PluginConnectionHolder {
  connection?: JsonRpcConnection;
}

export interface AdminSocketDeps {
  heartbeat: HeartbeatState;
  signingKeyHolder: SigningKeyHolder;
  store: StateStore;
  auditLog: AuditLog;
  pluginConnectionHolder: PluginConnectionHolder;
  stagingDir: string;
  bundlesDir: string;
  statusDir: string;
  secretsDir: string;
  certsDir: string;
  gateSnapshotHolder: GateSnapshotHolder;
  onApprovalChange?: () => void;
  onCertChange?: () => void;
  /** Triggers a reconcile after the framework doc changes (T5.3, docs/t5.3-decisions.md) -- same pattern as onApprovalChange/onCertChange. */
  onFrameworkChange?: () => void;
  /** T5.4 `wanfwctl doctor` deps -- optional so every pre-T5.4 caller/test keeps compiling unchanged; GET /doctor degrades each affected check to `skip` rather than erroring when omitted. */
  docker?: DockerClient;
  dockerSocketPath?: string;
  probeNetwork?: (mode: "macvlan", parent: string) => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Admin socket (§2.3): every security mutation lives here (trust, grant,
 * approve, secrets, key ops). Routes accumulate task by task (T2.x-T6.x).
 * Every mutation writes an audit entry before responding.
 */
export function buildAdminSocketRouter(deps: AdminSocketDeps): JsonUdsRouter {
  const router = new JsonUdsRouter();
  const { heartbeat, signingKeyHolder, store, auditLog } = deps;

  const trustDeps = (): TrustFlowDeps => ({
    store,
    signingKey: signingKeyHolder.manager,
    auditLog,
    stagingDir: deps.stagingDir,
    bundlesDir: deps.bundlesDir,
  });

  router.register("GET", "/status", async () => ({
    status: 200,
    body: heartbeat.current,
  }));

  router.register("GET", "/key", async () => ({
    status: 200,
    body: { publicKeyPem: signingKeyHolder.manager.getPublicKeyPem() },
  }));

  router.register("POST", "/key/rotate", async () => {
    await signingKeyHolder.manager.rotate();
    signingKeyHolder.manager.reSignAll(store);
    auditLog.append({ type: "key.rotate", details: {} });
    return { status: 200, body: { publicKeyPem: signingKeyHolder.manager.getPublicKeyPem() } };
  });

  router.register("POST", "/key/import", async ({ body }) => {
    const { privateKeyPem } = (body ?? {}) as { privateKeyPem?: string };
    if (!privateKeyPem) {
      return { status: 400, body: { error: "usage", message: "privateKeyPem is required" } };
    }
    signingKeyHolder.manager = await SigningKeyManager.importFrom(signingKeyHolder.keyPath, privateKeyPem);
    auditLog.append({ type: "key.import", details: {} });
    return { status: 200, body: { publicKeyPem: signingKeyHolder.manager.getPublicKeyPem() } };
  });

  router.register("GET", "/audit", async () => ({
    status: 200,
    body: { entries: auditLog.readAll() },
  }));

  router.register("POST", "/audit/verify", async () => ({
    status: 200,
    body: auditLog.verify(),
  }));

  router.register("GET", "/plugins", async ({ req }) => {
    const url = new URL(req.url ?? "/", "http://unix");
    if (url.searchParams.get("pending") === "true") {
      const staged = await listStagedBundles(deps.stagingDir);
      return { status: 200, body: { staged } };
    }
    const trusted = store.listTrustRecords();
    return { status: 200, body: { trusted } };
  });

  router.register("GET", "/plugins/:id", async ({ params }) => {
    const trusted = store.listTrustRecords().filter((r) => r.plugin_id === params.id);
    if (trusted.length === 0) {
      return { status: 404, body: { error: "not_found", message: `no trusted plugin ${params.id}` } };
    }
    const grants = store.listGrants(params.id!);
    return { status: 200, body: { trusted, grants } };
  });

  router.register("POST", "/plugins/trust", async ({ body }) => {
    const { id, sha256 } = (body ?? {}) as { id?: string; sha256?: string };
    if (!id || !sha256) {
      return { status: 400, body: { error: "usage", message: "id and sha256 are required" } };
    }
    try {
      const result = await trustStagedBundle(trustDeps(), id, sha256);
      await publishComposedSchema(store, deps.bundlesDir, deps.statusDir);
      return { status: 200, body: result };
    } catch (err) {
      if (err instanceof TrustFlowError) {
        return { status: 409, body: { error: "refused", message: err.message } };
      }
      throw err;
    }
  });

  router.register("POST", "/plugins/trust-builtins", async ({ body }) => {
    const connection = deps.pluginConnectionHolder.connection;
    if (!connection) {
      return { status: 502, body: { error: "pluginhost_unreachable", message: "no active pluginhost connection" } };
    }
    // Optional `ids` filter (T5.3): the pluginhost image ships test-only
    // builtins alongside production ones (e.g. dns-mock, T4.7's Pebble
    // harness) -- `wanfwctl init` must never trust those on a real
    // deployment. Omitted (the pre-T5.3 behavior, still used by
    // `--builtin-all` for dev/test) trusts every builtin the image ships.
    const { ids } = (body ?? {}) as { ids?: string[] };
    const builtins = (await connection.call("builtins.list")) as Array<{
      id: string;
      version: string;
      manifest: unknown;
      sha256: string;
    }>;
    const filtered = ids ? builtins.filter((b) => ids.includes(b.id)) : builtins;
    const results = [];
    for (const builtin of filtered) {
      const read = (await connection.call("builtins.read", { id: builtin.id })) as {
        files: Array<{ relPath: string; contentBase64: string }>;
      };
      const result = await trustBuiltin(trustDeps(), {
        id: builtin.id,
        version: builtin.version,
        manifest: builtin.manifest as never,
        sha256: builtin.sha256,
        files: read.files,
      });
      results.push(result);
    }
    await publishComposedSchema(store, deps.bundlesDir, deps.statusDir);
    return { status: 200, body: { trusted: results } };
  });

  // WAN IP detection (T5.3, §11 init): the pluginhost's `helper.wanIp` RPC
  // (a real outbound HTTP call) is the only real network egress in this
  // whole system (the orchestrator itself has none, §12.5) -- exposed here
  // purely so `wanfwctl init` can print the real detected WAN IP alongside
  // the DNS-record instructions, never used by the reconcile pipeline
  // itself.
  router.register("GET", "/network/wan-ip", async () => {
    const connection = deps.pluginConnectionHolder.connection;
    if (!connection) {
      return { status: 502, body: { error: "pluginhost_unreachable", message: "no active pluginhost connection" } };
    }
    try {
      const result = (await connection.call("helper.wanIp")) as { ip?: string };
      return { status: 200, body: { ip: result.ip ?? null } };
    } catch (err) {
      return { status: 502, body: { error: "wan_ip_detect_failed", message: (err as Error).message } };
    }
  });

  // T5.4 `wanfwctl doctor`: reuses the same `helper.wanIp`/`helper.resolveA`
  // pluginhost RPCs and the same `probeMacvlan` real Docker-daemon check
  // T5.2's `net.probeNetwork` already established, wrapped so a missing
  // pluginhost connection degrades individual checks to `skip` rather than
  // failing the whole report.
  router.register("GET", "/doctor", async () => {
    const connection = deps.pluginConnectionHolder.connection;
    const checks = await runDoctorChecks({
      dockerSocketPath: deps.dockerSocketPath,
      store,
      docker: deps.docker,
      probeNetwork: deps.probeNetwork,
      detectWanIp: connection
        ? async () => {
            const result = (await connection.call("helper.wanIp")) as { ip?: string };
            return result.ip;
          }
        : undefined,
      resolveA: connection
        ? async (hostname: string) => {
            const result = (await connection.call("helper.resolveA", { hostname })) as { addresses?: string[] };
            return result.addresses ?? [];
          }
        : undefined,
    });
    return { status: 200, body: { checks } };
  });

  router.register("POST", "/plugins/untrust", async ({ body }) => {
    const { id } = (body ?? {}) as { id?: string };
    if (!id) {
      return { status: 400, body: { error: "usage", message: "id is required" } };
    }
    try {
      untrustPlugin(trustDeps(), id);
      await publishComposedSchema(store, deps.bundlesDir, deps.statusDir);
      return { status: 200, body: { pluginId: id, untrusted: true } };
    } catch (err) {
      if (err instanceof TrustFlowError) {
        return { status: 404, body: { error: "not_found", message: err.message } };
      }
      throw err;
    }
  });

  router.register("POST", "/plugins/:id/invoke", async ({ params, body }) => {
    const { task, input, limits } = (body ?? {}) as {
      task?: string;
      input?: unknown;
      limits?: { wallMs: number; memMb: number; cpuSeconds: number };
    };
    if (!task) {
      return { status: 400, body: { error: "usage", message: "task is required" } };
    }
    const invokeDeps = { store, auditLog, pluginConnectionHolder: deps.pluginConnectionHolder, bundlesDir: deps.bundlesDir };
    try {
      const result = await invokeTrustedPlugin(
        invokeDeps,
        params.id!,
        task,
        input ?? {},
        // See wanfwctl's cli.ts for the memMb floor rationale (V8 startup cost).
        limits ?? { wallMs: 30_000, memMb: 768, cpuSeconds: 30 },
      );
      return { status: 200, body: result };
    } catch (err) {
      if (err instanceof TrustFlowError) {
        return { status: 404, body: { error: "not_found", message: err.message } };
      }
      return { status: 502, body: { error: "invoke_failed", message: (err as Error).message } };
    }
  });

  router.register("GET", "/plans", async ({ req }) => {
    const url = new URL(req.url ?? "/", "http://unix");
    const all = [...deps.gateSnapshotHolder.services.values()];
    const plans = url.searchParams.get("pending") === "true" ? all.filter((s) => !s.approved) : all;
    return { status: 200, body: { plans } };
  });

  router.register("GET", "/plans/:id", async ({ params }) => {
    const plan = deps.gateSnapshotHolder.services.get(params.id!);
    if (!plan) return { status: 404, body: { error: "not_found", message: `no gated plan for service ${params.id}` } };
    return { status: 200, body: plan };
  });

  router.register("POST", "/plans/approve", async ({ body }) => {
    const { serviceId, projectionHash } = (body ?? {}) as { serviceId?: string; projectionHash?: string };
    let plan = projectionHash
      ? [...deps.gateSnapshotHolder.services.values()].find((s) => s.projectionHash === projectionHash)
      : serviceId
        ? deps.gateSnapshotHolder.services.get(serviceId)
        : undefined;
    if (!plan) {
      return { status: 404, body: { error: "not_found", message: "no matching pending plan (it may already be approved, or the reconciler hasn't produced it yet)" } };
    }

    const payload = canonicalApprovalPayload(plan.projectionHash, plan.serviceId, plan.humanRendering);
    store.insertApproval({
      projection_hash: plan.projectionHash,
      service_id: plan.serviceId,
      human_rendering: plan.humanRendering,
      sig: signingKeyHolder.manager.sign(payload),
      approved_at: new Date().toISOString(),
    });
    auditLog.append({ type: "plan.approve", details: { serviceId: plan.serviceId, projectionHash: plan.projectionHash } });
    deps.onApprovalChange?.();
    return { status: 200, body: { approved: true, serviceId: plan.serviceId, projectionHash: plan.projectionHash } };
  });

  router.register("POST", "/plans/revoke", async ({ body }) => {
    const { projectionHash } = (body ?? {}) as { projectionHash?: string };
    if (!projectionHash) {
      return { status: 400, body: { error: "usage", message: "projectionHash is required" } };
    }
    store.revokeApproval(projectionHash);
    auditLog.append({ type: "plan.revoke", details: { projectionHash } });
    deps.onApprovalChange?.();
    return { status: 200, body: { revoked: true, projectionHash } };
  });

  router.register("GET", "/secrets", async () => ({
    status: 200,
    body: { secrets: listSecrets(deps.secretsDir) }, // names + lastRotated only, never values (§12.4)
  }));

  router.register("POST", "/secrets", async ({ body }) => {
    const { name, value } = (body ?? {}) as { name?: string; value?: string };
    if (!name || value === undefined) {
      return { status: 400, body: { error: "usage", message: "name and value are required" } };
    }
    putSecret(deps.secretsDir, name, value);
    auditLog.append({ type: "secret.set", details: { name } }); // value never logged
    return { status: 200, body: { name, set: true } };
  });

  router.register("POST", "/secrets/unset", async ({ body }) => {
    const { name } = (body ?? {}) as { name?: string };
    if (!name) {
      return { status: 400, body: { error: "usage", message: "name is required" } };
    }
    unsetSecret(deps.secretsDir, name);
    auditLog.append({ type: "secret.unset", details: { name } });
    return { status: 200, body: { name, unset: true } };
  });

  router.register("GET", "/certs", async () => ({
    status: 200,
    body: { certs: listCerts(deps.certsDir) },
  }));

  router.register("POST", "/certs/:name/rollback", async ({ params }) => {
    const name = params.name;
    if (!name) {
      return { status: 400, body: { error: "usage", message: "name is required" } };
    }
    try {
      const rolledBackTo = rollbackCert(deps.certsDir, name);
      auditLog.append({ type: "cert.rollback", details: { name, rolledBackTo } });
      deps.onCertChange?.();
      return { status: 200, body: { name, rolledBackTo } };
    } catch (err) {
      return { status: 400, body: { error: "rollback-failed", message: (err as Error).message } };
    }
  });

  // -- framework document (T5.3, docs/t5.3-decisions.md) -------------------
  // The framework doc lives in wanfw_state, authored only here -- never
  // wanfw_desired, which tier1 (not admin.sock) writes and the orchestrator
  // only ever reads (§12.5's tier1/orchestrator trust split). Validated at
  // write time with the exact same validators/migrations the file loader
  // would run, so a bad doc is rejected here with a clear message instead
  // of surfacing later as a reconcile-stage failure.
  router.register("GET", "/framework", async () => ({
    status: 200,
    body: { framework: store.getFrameworkDoc() ?? null },
  }));

  router.register("POST", "/framework", async ({ body }) => {
    if (body === undefined || body === null) {
      return { status: 400, body: { error: "usage", message: "a framework document body is required" } };
    }
    const { error } = validateEnvelope(body, "admin-socket:/framework");
    if (error) {
      return { status: 400, body: { error: "invalid", message: error.message } };
    }
    store.setFrameworkDoc(body);
    auditLog.append({ type: "framework.set", details: {} });
    deps.onFrameworkChange?.();
    return { status: 200, body: { set: true } };
  });

  return router;
}
