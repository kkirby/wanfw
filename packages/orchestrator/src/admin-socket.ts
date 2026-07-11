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
} from "./trust/index.js";

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
    return { status: 200, body: { trusted: results } };
  });

  router.register("POST", "/plugins/untrust", async ({ body }) => {
    const { id } = (body ?? {}) as { id?: string };
    if (!id) {
      return { status: 400, body: { error: "usage", message: "id is required" } };
    }
    try {
      untrustPlugin(trustDeps(), id);
      return { status: 200, body: { pluginId: id, untrusted: true } };
    } catch (err) {
      if (err instanceof TrustFlowError) {
        return { status: 404, body: { error: "not_found", message: err.message } };
      }
      throw err;
    }
  });

  return router;
}
