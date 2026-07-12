import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { JsonUdsRouter } from "./uds-server.js";
import type { HeartbeatState } from "./heartbeat.js";
import type { StateStore } from "./state-store/store.js";
import { listStagedBundles } from "./trust/index.js";
import { validateDraftDocument, type ComposedSchema } from "./composed-schema/index.js";
import type { GateSnapshotHolder } from "./reconciler/index.js";
import { listSecrets } from "./secrets/store.js";
import { listCerts } from "./certs/store.js";

/**
 * Status socket (§2.2): read-only, pure validation, and a nudge. Zero
 * mutating endpoints. This fixed route set is the enforcement surface for
 * invariant #4 -- the allowlist test in status-socket.test.ts must stay
 * green forever; do not add routes here without updating that test's
 * intent, and never add a route that mutates state.
 *
 * Plugin trust/grant reads live here too (not only on admin.sock): tier1
 * has zero network path to admin.sock (container-private, no shared
 * volume), but T2.10 requires the plugins page to show installed/trusted
 * plugins and pending-trust items. These are pure reads of the same
 * StateStore/staging dir the admin socket already reads from.
 */
export const STATUS_SOCKET_ROUTE_ALLOWLIST: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/status" },
  { method: "GET", path: "/status/services" },
  { method: "GET", path: "/status/services/:id" },
  { method: "GET", path: "/schema" },
  { method: "GET", path: "/approvals/pending" },
  { method: "POST", path: "/validate" },
  { method: "POST", path: "/nudge" },
  { method: "GET", path: "/plugins" },
  { method: "GET", path: "/plugins/:id" },
  { method: "GET", path: "/plans" },
  { method: "GET", path: "/plans/:id" },
  { method: "GET", path: "/secrets" },
  { method: "GET", path: "/certs" },
  { method: "GET", path: "/framework" },
];

export interface NudgeState {
  nudgedAt: string | null;
  count: number;
}

export interface StatusSocketDeps {
  heartbeat: HeartbeatState;
  nudge: NudgeState;
  store: StateStore;
  stagingDir: string;
}

export function buildStatusSocketRouter(
  heartbeat: HeartbeatState,
  nudge: NudgeState,
  extra?: {
    store: StateStore;
    stagingDir: string;
    statusDir?: string;
    secretsDir?: string;
    certsDir?: string;
    gateSnapshotHolder?: GateSnapshotHolder;
    onNudge?: () => void;
  },
): JsonUdsRouter {
  const router = new JsonUdsRouter();

  router.register("GET", "/status", async () => ({
    status: 200,
    body: heartbeat.current,
  }));

  router.register("GET", "/status/services", async () => {
    if (!extra?.statusDir) return { status: 200, body: { services: [] } };
    try {
      const files = await readdir(join(extra.statusDir, "services"));
      const services = await Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .map(async (f) => JSON.parse(await readFile(join(extra.statusDir!, "services", f), "utf8"))),
      );
      return { status: 200, body: { services } };
    } catch {
      return { status: 200, body: { services: [] } };
    }
  });

  router.register("GET", "/status/services/:id", async ({ params }) => {
    if (!extra?.statusDir) {
      return { status: 404, body: { error: "not_found", message: `no service '${params.id}'` } };
    }
    try {
      const raw = await readFile(join(extra.statusDir, "services", `${params.id}.json`), "utf8");
      return { status: 200, body: JSON.parse(raw) };
    } catch {
      return { status: 404, body: { error: "not_found", message: `no service '${params.id}'` } };
    }
  });

  router.register("GET", "/schema", async () => {
    if (!extra?.statusDir) {
      return { status: 404, body: { error: "not_implemented", message: "composed schema publishing lands in T3.2" } };
    }
    try {
      const raw = await readFile(join(extra.statusDir, "schema.json"), "utf8");
      return { status: 200, body: JSON.parse(raw) };
    } catch {
      return { status: 404, body: { error: "not_found", message: "no composed schema published yet" } };
    }
  });

  router.register("GET", "/approvals/pending", async () => {
    const services = extra?.gateSnapshotHolder?.services;
    if (!services) return { status: 200, body: { pending: [] } };
    const pending = [...services.values()].filter((s) => !s.approved);
    return { status: 200, body: { pending } };
  });

  router.register("POST", "/validate", async ({ body }) => {
    if (!extra?.statusDir) {
      return { status: 501, body: { error: "not_implemented", message: "validate lands in T3.2" } };
    }
    let composed: ComposedSchema;
    try {
      const raw = await readFile(join(extra.statusDir, "schema.json"), "utf8");
      composed = JSON.parse(raw) as ComposedSchema;
    } catch {
      return { status: 503, body: { error: "schema_unavailable", message: "no composed schema published yet" } };
    }
    const result = validateDraftDocument(composed, body);
    return { status: 200, body: result };
  });

  router.register("POST", "/nudge", async () => {
    nudge.nudgedAt = new Date().toISOString();
    nudge.count += 1;
    extra?.onNudge?.();
    return { status: 202, body: { acknowledged: true } };
  });

  router.register("GET", "/plugins", async ({ req }) => {
    if (!extra) return { status: 200, body: { trusted: [] } };
    const url = new URL(req.url ?? "/", "http://unix");
    if (url.searchParams.get("pending") === "true") {
      const staged = await listStagedBundles(extra.stagingDir);
      return { status: 200, body: { staged } };
    }
    return { status: 200, body: { trusted: extra.store.listTrustRecords() } };
  });

  router.register("GET", "/plugins/:id", async ({ params }) => {
    if (!extra) return { status: 404, body: { error: "not_found" } };
    const trusted = extra.store.listTrustRecords().filter((r) => r.plugin_id === params.id);
    if (trusted.length === 0) {
      return { status: 404, body: { error: "not_found", message: `no trusted plugin ${params.id}` } };
    }
    const grants = extra.store.listGrants(params.id!);
    return { status: 200, body: { trusted, grants } };
  });

  router.register("GET", "/plans", async ({ req }) => {
    const services = extra?.gateSnapshotHolder?.services;
    if (!services) return { status: 200, body: { plans: [] } };
    const url = new URL(req.url ?? "/", "http://unix");
    const all = [...services.values()];
    const plans = url.searchParams.get("pending") === "true" ? all.filter((s) => !s.approved) : all;
    return { status: 200, body: { plans } };
  });

  router.register("GET", "/plans/:id", async ({ params }) => {
    const services = extra?.gateSnapshotHolder?.services;
    const plan = services?.get(params.id!);
    if (!plan) return { status: 404, body: { error: "not_found", message: `no gated plan for service ${params.id}` } };
    return { status: 200, body: plan };
  });

  // Same tier1-has-no-path-to-admin.sock mirror pattern as /plugins and
  // /plans: names + lastRotated only, never values (§12.4) -- this is a
  // pure read of the same secrets dir the admin socket's set/unset routes
  // already write to.
  router.register("GET", "/secrets", async () => {
    if (!extra?.secretsDir) return { status: 200, body: { secrets: [] } };
    return { status: 200, body: { secrets: listSecrets(extra.secretsDir) } };
  });

  // Pure read of the same cert volume the admin socket's store/rollback routes write to.
  router.register("GET", "/certs", async () => {
    if (!extra?.certsDir) return { status: 200, body: { certs: [] } };
    return { status: 200, body: { certs: listCerts(extra.certsDir) } };
  });

  // Read-only mirror of the admin socket's framework doc (T5.3,
  // docs/t5.3-decisions.md) -- tier1's setup page and dashboard need to
  // read it (operator instructions, domain, roles), but tier1 has no path
  // to admin.sock and must never be able to author it.
  router.register("GET", "/framework", async () => {
    if (!extra) return { status: 200, body: { framework: null } };
    return { status: 200, body: { framework: extra.store.getFrameworkDoc() ?? null } };
  });

  return router;
}
