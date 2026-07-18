import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { atomicWriteFile } from "@wanfw/core-schemas";
import type { StateStore } from "../state-store/store.js";
import type { DesiredState } from "../desired-state/index.js";
import type { NamedStage, ReconcileRunContext, StageError, StageResult } from "./types.js";
import type { GatedService } from "./gate-stage.js";
import type { DockerClient } from "../execute/docker-client.js";
import type { PlanGraph } from "./plan-stage.js";
import { WILDCARD_CERT_NAME } from "./plan-stage.js";
import { CERT_LIFETIME_DAYS } from "../renewal/scheduler.js";

export interface ObserveStageDeps {
  store: StateStore;
  docker: DockerClient;
  statusDir: string;
  /** meta.storedAt / meta.names of the wildcard cert's current generation, or undefined if it's never been stored -- same shape/source RENEWAL already reads (T4.6). Optional so existing callers/tests that don't care about cert status keep working unchanged. */
  readCertMeta?: (certName: string) => { storedAt: string; names: string[] } | undefined;
}

/** Projects a service's cert-expiry field from the stored generation's `storedAt` plus the fixed 90-day Let's Encrypt lifetime (renewal/scheduler.ts's own documented assumption) -- not parsed from the certificate's real X.509 notAfter, since this codebase deliberately has no DER parser. Returns null when no cert covers this service's hostname yet. */
function projectCertNotAfter(hostname: string | undefined, meta: { storedAt: string; names: string[] } | undefined): string | null {
  if (!hostname || !meta || !meta.names.includes(hostname)) return null;
  return new Date(new Date(meta.storedAt).getTime() + CERT_LIFETIME_DAYS * 24 * 3600_000).toISOString();
}

/** A framework-wide renewal degradation (ctx.degradedReason from RENEWAL, T4.6) is surfaced as this service's own lastError only when the service's hostname is actually among the names the failing cert covers -- an unrelated service shouldn't show a scary error for a cert it doesn't need. */
function renewalErrorFor(hostname: string | undefined, degradedReason: StageError | undefined, certNames: string[] | undefined): StageError | undefined {
  if (!hostname || !degradedReason || degradedReason.stage !== "renewal") return undefined;
  if (certNames && !certNames.includes(hostname)) return undefined;
  return degradedReason;
}

export type ServicePhase = "pending" | "reconciling" | "live" | "degraded" | "pending-approval" | "error";

export interface ServiceStatusDoc {
  serviceId: string;
  phase: ServicePhase;
  endpoints: string[];
  certNotAfter: string | null;
  lastError?: StageError;
  needsPersist?: { toVersion: number };
}

function computeServicePhase(
  serviceId: string,
  gate: GatedService | undefined,
  containerRunning: boolean,
  lastError: StageError | undefined,
): ServicePhase {
  if (lastError && lastError.plugin === serviceId) return "error";
  if (gate && !gate.approved) return "pending-approval";
  if (containerRunning) return "live";
  return "reconciling";
}

/**
 * OBSERVE stage (§7 OBSERVE, §13, ADR-9, T3.9): the last pipeline stage.
 * Inspects every `wanfw.managed=true` object (unlabeled bystanders are
 * structurally invisible -- the DockerClient GC queries only ever ask for
 * managed objects), writes a per-service status document, and garbage
 * collects labeled objects whose `wanfw.service` no longer appears in
 * desired state: containers first, then their per-service networks, then
 * volumes -- and volumes only when the object itself was labeled
 * `wanfw.removeVolumesOnDelete=true` at creation time (T3.8's ensureVolume
 * sets this from the service doc's `expose.removeVolumesOnDelete`, default
 * false, so data survives service removal unless explicitly opted in).
 */
export function buildObserveStage(deps: ObserveStageDeps): NamedStage {
  return {
    name: "observe",
    run: async (ctx: ReconcileRunContext): Promise<StageResult> => {
      const desiredState = ctx.desiredState as DesiredState | undefined;
      const gateSnapshot = ctx.gateSnapshot as Map<string, GatedService> | undefined;
      if (!desiredState?.framework) {
        return { ok: true };
      }

      const desiredServiceIds = new Set(desiredState.services.keys());
      const planId = (ctx.executedPlanId as string | undefined) ?? "observe";
      const journal = (step: string, payload: unknown, result: unknown) => {
        deps.store.appendJournal({
          plan_id: planId,
          step,
          payload_json: JSON.stringify(payload),
          result: JSON.stringify(result),
          ts: new Date().toISOString(),
        });
      };

      // GC order: containers -> networks -> volumes (opt-in only).
      const containers = await deps.docker.listManagedContainers();
      const orphanContainers = containers.filter((c) => c.labels["wanfw.service"] && !desiredServiceIds.has(c.labels["wanfw.service"]!));
      for (const c of orphanContainers) {
        await deps.docker.removeContainer(c.id);
        journal(`gc:container:${c.name}`, { name: c.name }, { removed: true });
      }

      const networks = await deps.docker.listManagedNetworks();
      const orphanNetworks = networks.filter((n) => n.labels["wanfw.service"] && !desiredServiceIds.has(n.labels["wanfw.service"]!));
      for (const n of orphanNetworks) {
        await deps.docker.removeNetwork(n.id);
        journal(`gc:network:${n.name}`, { name: n.name }, { removed: true });
      }

      const volumes = await deps.docker.listManagedVolumes();
      const orphanVolumes = volumes.filter((v) => v.labels["wanfw.service"] && !desiredServiceIds.has(v.labels["wanfw.service"]!));
      for (const v of orphanVolumes) {
        if (v.labels["wanfw.removeVolumesOnDelete"] === "true") {
          await deps.docker.removeVolume(v.name);
          journal(`gc:volume:${v.name}`, { name: v.name }, { removed: true });
        } else {
          journal(`gc:volume:${v.name}`, { name: v.name }, { removed: false, reason: "removeVolumesOnDelete not set, data kept" });
        }
      }

      // Status documents (§13): one per remaining desired service.
      const remainingContainers = await deps.docker.listManagedContainers();
      const certMeta = deps.readCertMeta?.(WILDCARD_CERT_NAME);
      const requiredCertNames = (ctx.planGraph as PlanGraph | undefined)?.certRequirements.names;
      const degradedReason = ctx.degradedReason as StageError | undefined;
      for (const [serviceId, doc] of desiredState.services) {
        const gate = gateSnapshot?.get(serviceId);
        const container = remainingContainers.find((c) => c.labels["wanfw.service"] === serviceId);
        const expose = doc.spec.expose as { hostname?: string } | undefined;
        const hostname = expose?.hostname;
        // The one wildcard cert covers every exposed hostname (T4.5's
        // convention), so a renewal problem is only this service's own
        // lastError when its hostname is actually among the names that
        // cert is required to (or does) cover -- not every service just
        // because *some* cert somewhere is degraded.
        const lastError = renewalErrorFor(hostname, degradedReason, requiredCertNames ?? certMeta?.names);
        const statusDoc: ServiceStatusDoc = {
          serviceId,
          phase: computeServicePhase(serviceId, gate, container?.state === "running", lastError),
          endpoints: hostname ? [hostname] : [],
          certNotAfter: projectCertNotAfter(hostname, certMeta),
          ...(lastError ? { lastError } : {}),
          ...(doc.needsPersist ? { needsPersist: doc.needsPersist } : {}),
        };
        await atomicWriteFile(join(deps.statusDir, "services", `${serviceId}.json`), JSON.stringify(statusDoc, null, 2));
      }

      // Status docs for services no longer in desired state are stale (§13
      // documents are a projection of desired state, same lifecycle as the
      // Docker objects GC'd above).
      const existingStatusFiles = await readdir(join(deps.statusDir, "services")).catch(() => [] as string[]);
      for (const file of existingStatusFiles) {
        const serviceId = file.replace(/\.json$/, "");
        if (!desiredServiceIds.has(serviceId)) {
          await rm(join(deps.statusDir, "services", file), { force: true });
        }
      }

      return { ok: true };
    },
  };
}
