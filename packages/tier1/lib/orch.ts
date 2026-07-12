import "server-only";
import { request } from "node:http";

// Never import this module from client components: it is server-side only
// (server components, server actions, route handlers), and it never touches
// the plugin socket (invariant #3 -- tier1 has no path to orch-plugin.sock).
const STATUS_SOCKET_PATH = process.env.WANFW_STATUS_SOCKET_PATH ?? "/run/wanfw/orch-status.sock";

export interface OrchRequestResult {
  status: number;
  body: unknown;
}

export function orchRequest(method: string, path: string, body?: unknown): Promise<OrchRequestResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath: STATUS_SOCKET_PATH,
        path,
        method,
        timeout: 5_000,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("orch-status.sock request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function getFrameworkStatus(): Promise<OrchRequestResult> {
  return orchRequest("GET", "/status");
}

export interface TrustRecord {
  plugin_id: string;
  version: string;
  sha256: string;
  granted_caps_json: string;
  created_at: string;
  revoked_at: string | null;
}

export interface StagedBundleManifest {
  id: string;
  version: string;
  capabilities: Array<{ cap: string; scope: Record<string, unknown>; reason: string }>;
}

export interface StagedBundle {
  dirName: string;
  bundleDir: string;
  sha256: string;
  manifest?: StagedBundleManifest;
  manifestErrors?: string[];
}

export interface GrantRecord {
  id: number;
  plugin_id: string;
  cap: string;
  scope_json: string;
  created_at: string;
  revoked_at: string | null;
}

export async function listTrustedPlugins(): Promise<TrustRecord[]> {
  const res = await orchRequest("GET", "/plugins");
  return (res.body as { trusted: TrustRecord[] }).trusted;
}

export async function listPendingPlugins(): Promise<StagedBundle[]> {
  const res = await orchRequest("GET", "/plugins?pending=true");
  return (res.body as { staged: StagedBundle[] }).staged;
}

export async function getTrustedPlugin(
  id: string,
): Promise<{ trusted: TrustRecord[]; grants: GrantRecord[] } | undefined> {
  const res = await orchRequest("GET", `/plugins/${encodeURIComponent(id)}`);
  if (res.status !== 200) return undefined;
  return res.body as { trusted: TrustRecord[]; grants: GrantRecord[] };
}

export interface ComposedSchema {
  envelope: unknown;
  framework: unknown;
  service: unknown;
  pluginConfigSchemas: Record<string, unknown>;
  boundDeployPluginId?: string;
}

/** The composed schema (§5.5) T3.13's form renderer walks -- published by the orchestrator after every plugin-set change. */
export async function getComposedSchema(): Promise<ComposedSchema | undefined> {
  const res = await orchRequest("GET", "/schema");
  if (res.status !== 200) return undefined;
  return res.body as ComposedSchema;
}

export interface ServiceStatusDoc {
  serviceId: string;
  phase: "pending" | "reconciling" | "live" | "degraded" | "pending-approval" | "error";
  endpoints: string[];
  certNotAfter: string | null;
  lastError?: { stage: string; plugin?: string; message: string };
  needsPersist?: { toVersion: number };
}

export async function listServiceStatuses(): Promise<ServiceStatusDoc[]> {
  const res = await orchRequest("GET", "/status/services");
  return ((res.body as { services: ServiceStatusDoc[] } | undefined)?.services) ?? [];
}

export async function getServiceStatus(id: string): Promise<ServiceStatusDoc | undefined> {
  const res = await orchRequest("GET", `/status/services/${encodeURIComponent(id)}`);
  if (res.status !== 200) return undefined;
  return res.body as ServiceStatusDoc;
}

export interface GatedPlan {
  serviceId: string;
  tier: "baseline" | "powerful";
  projectionHash: string;
  humanRendering: string;
  approved: boolean;
}

/** Pending/approved powerful plans (GATE, T3.7) -- read-only here; approval is CLI-only (ADR-6), never a tier1 button. */
export async function listGatedPlans(): Promise<GatedPlan[]> {
  const res = await orchRequest("GET", "/plans");
  return ((res.body as { plans: GatedPlan[] } | undefined)?.plans) ?? [];
}

export interface SecretListEntry {
  name: string;
  lastRotated: string;
}

/** Names + lastRotated only (§12.4) -- values never traverse tier1 at all; set/unset is CLI-only, same no-mutation-button pattern as approvals (ADR-6). */
export async function listSecrets(): Promise<SecretListEntry[]> {
  const res = await orchRequest("GET", "/secrets");
  return ((res.body as { secrets: SecretListEntry[] } | undefined)?.secrets) ?? [];
}
