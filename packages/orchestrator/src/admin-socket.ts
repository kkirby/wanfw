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
  gateSnapshotHolder: GateSnapshotHolder;
  onApprovalChange?: () => void;
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

  router.register("POST", "/plugins/trust-builtins", async () => {
    const connection = deps.pluginConnectionHolder.connection;
    if (!connection) {
      return { status: 502, body: { error: "pluginhost_unreachable", message: "no active pluginhost connection" } };
    }
    const builtins = (await connection.call("builtins.list")) as Array<{
      id: string;
      version: string;
      manifest: unknown;
      sha256: string;
    }>;
    const results = [];
    for (const builtin of builtins) {
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

  return router;
}
