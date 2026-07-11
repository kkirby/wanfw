import { JsonUdsRouter } from "./uds-server.js";
import type { HeartbeatState } from "./heartbeat.js";
import { SigningKeyManager } from "./signing-key.js";
import type { StateStore } from "./state-store/store.js";

/** Mutable holder so `key import`/`key rotate` can swap the live manager instance. */
export interface SigningKeyHolder {
  manager: SigningKeyManager;
  keyPath: string;
}

export interface AdminSocketDeps {
  heartbeat: HeartbeatState;
  signingKeyHolder: SigningKeyHolder;
  store: StateStore;
}

/**
 * Admin socket (§2.3): every security mutation lives here (trust, grant,
 * approve, secrets, key ops). Routes accumulate task by task (T2.x-T6.x).
 */
export function buildAdminSocketRouter(deps: AdminSocketDeps): JsonUdsRouter {
  const router = new JsonUdsRouter();
  const { heartbeat, signingKeyHolder, store } = deps;

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
    return { status: 200, body: { publicKeyPem: signingKeyHolder.manager.getPublicKeyPem() } };
  });

  router.register("POST", "/key/import", async ({ body }) => {
    const { privateKeyPem } = (body ?? {}) as { privateKeyPem?: string };
    if (!privateKeyPem) {
      return { status: 400, body: { error: "usage", message: "privateKeyPem is required" } };
    }
    signingKeyHolder.manager = await SigningKeyManager.importFrom(signingKeyHolder.keyPath, privateKeyPem);
    return { status: 200, body: { publicKeyPem: signingKeyHolder.manager.getPublicKeyPem() } };
  });

  return router;
}
