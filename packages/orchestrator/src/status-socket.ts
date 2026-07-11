import { JsonUdsRouter } from "./uds-server.js";
import type { HeartbeatState } from "./heartbeat.js";

/**
 * Status socket (§2.2): read-only, pure validation, and a nudge. Zero
 * mutating endpoints. This fixed route set is the enforcement surface for
 * invariant #4 -- the allowlist test in status-socket.test.ts must stay
 * green forever; do not add routes here without updating that test's
 * intent, and never add a route that mutates state.
 */
export const STATUS_SOCKET_ROUTE_ALLOWLIST: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/status" },
  { method: "GET", path: "/status/services/:id" },
  { method: "GET", path: "/schema" },
  { method: "GET", path: "/approvals/pending" },
  { method: "POST", path: "/validate" },
  { method: "POST", path: "/nudge" },
];

export interface NudgeState {
  nudgedAt: string | null;
  count: number;
}

export function buildStatusSocketRouter(heartbeat: HeartbeatState, nudge: NudgeState): JsonUdsRouter {
  const router = new JsonUdsRouter();

  router.register("GET", "/status", async () => ({
    status: 200,
    body: heartbeat.current,
  }));

  router.register("GET", "/status/services/:id", async ({ params }) => ({
    status: 404,
    body: { error: "not_found", message: `no service '${params.id}' (reconciler lands in T3.x)` },
  }));

  router.register("GET", "/schema", async () => ({
    status: 404,
    body: { error: "not_implemented", message: "composed schema publishing lands in T3.2" },
  }));

  router.register("GET", "/approvals/pending", async () => ({
    status: 200,
    body: { pending: [] },
  }));

  router.register("POST", "/validate", async () => ({
    status: 501,
    body: { error: "not_implemented", message: "validate lands in T3.2; this must remain a pure function" },
  }));

  router.register("POST", "/nudge", async () => {
    nudge.nudgedAt = new Date().toISOString();
    nudge.count += 1;
    return { status: 202, body: { acknowledged: true } };
  });

  return router;
}
