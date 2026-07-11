import { JsonUdsRouter } from "./uds-server.js";
import type { HeartbeatState } from "./heartbeat.js";

/**
 * Admin socket (§2.3): every security mutation lives here eventually (trust,
 * grant, approve, secrets, key ops). T1.1/T1.3 wire up `status` only; the
 * rest arrive with their owning tasks (T2.x-T6.x).
 */
export function buildAdminSocketRouter(heartbeat: HeartbeatState): JsonUdsRouter {
  const router = new JsonUdsRouter();

  router.register("GET", "/status", async () => ({
    status: 200,
    body: heartbeat.current,
  }));

  return router;
}
