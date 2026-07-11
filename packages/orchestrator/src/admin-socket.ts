import { JsonUdsRouter } from "./uds-server.js";
import type { HeartbeatState } from "./heartbeat.js";
import { SigningKeyManager } from "./signing-key.js";
import type { StateStore } from "./state-store/store.js";
import type { AuditLog } from "./audit-log.js";

/** Mutable holder so `key import`/`key rotate` can swap the live manager instance. */
export interface SigningKeyHolder {
  manager: SigningKeyManager;
  keyPath: string;
}

export interface AdminSocketDeps {
  heartbeat: HeartbeatState;
  signingKeyHolder: SigningKeyHolder;
  store: StateStore;
  auditLog: AuditLog;
}

/**
 * Admin socket (§2.3): every security mutation lives here (trust, grant,
 * approve, secrets, key ops). Routes accumulate task by task (T2.x-T6.x).
 * Every mutation writes an audit entry before responding.
 */
export function buildAdminSocketRouter(deps: AdminSocketDeps): JsonUdsRouter {
  const router = new JsonUdsRouter();
  const { heartbeat, signingKeyHolder, store, auditLog } = deps;

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

  return router;
}
