import { computePowerfulProjectionHash, type PowerfulProjectionInput } from "@wanfw/core-schemas";
import type { StateStore } from "../state-store/store.js";
import type { DesiredState } from "../desired-state/index.js";
import type { ContainerSpec } from "../validate/index.js";
import type { NamedStage, ReconcileRunContext, StageResult } from "./types.js";
import type { PlanGraph } from "./plan-stage.js";

export interface GatedService {
  serviceId: string;
  tier: "baseline" | "powerful";
  projectionHash: string;
  humanRendering: string;
  approved: boolean;
}

/** Mutable holder so the admin/status sockets can read the latest GATE snapshot without re-running the pipeline. */
export interface GateSnapshotHolder {
  services: Map<string, GatedService>;
}

export interface GateStageDeps {
  store: StateStore;
}

function projectionInputFor(serviceId: string, spec: ContainerSpec): PowerfulProjectionInput {
  return {
    serviceId,
    image: spec.image,
    mounts: (spec.mounts ?? [])
      .filter((m): m is typeof m & { type: "bind" } => m.type === "bind")
      .map((m) => ({ source: m.source, target: m.target, ro: m.readOnly ?? false })),
    devices: spec.devices ?? [],
    networkMode: spec.networkMode === "host" ? "host" : null,
    privileged: spec.privileged ?? false,
    capAdd: spec.capAdd ?? [],
    publishedPorts: spec.ports ?? [],
  };
}

function humanRender(spec: ContainerSpec): string {
  const parts: string[] = [`image: ${spec.image}`];
  for (const mount of spec.mounts ?? []) {
    if (mount.type === "bind") {
      parts.push(`bind mount ${mount.source} ${mount.readOnly ? "read-only" : "read-write"} at ${mount.target}`);
    }
  }
  for (const device of spec.devices ?? []) parts.push(`device ${device}`);
  if (spec.privileged) parts.push("privileged: true");
  if (spec.networkMode === "host") parts.push("network mode: host");
  for (const cap of spec.capAdd ?? []) parts.push(`capability ${cap}`);
  for (const port of spec.ports ?? []) parts.push(`publish port ${port}`);
  return parts.join("; ");
}

/**
 * GATE stage (§7 GATE, T3.7): every powerful-tier plan needs a matching
 * approval record (keyed by the powerful projection hash) before it may
 * execute; `strictApprovals: "all"` extends that requirement to every
 * service regardless of tier. A plan without a matching approval "parks"
 * -- this is not a stage failure (pending-approval is an expected,
 * ordinary state, not a fault), it just means EXECUTE (T3.8) won't touch
 * that service yet. The GATE snapshot is held for the admin/status
 * sockets to read without re-running the pipeline (`plan list --pending`,
 * `plan show`, the copyable `plan approve` command tier1 displays).
 */
export function buildGateStage(deps: GateStageDeps, holder: GateSnapshotHolder): NamedStage {
  return {
    name: "gate",
    run: async (ctx: ReconcileRunContext): Promise<StageResult> => {
      const desiredState = ctx.desiredState as DesiredState | undefined;
      const planGraph = ctx.planGraph as PlanGraph | undefined;
      const validation = ctx.validation as Record<string, { tier: string; projectionHash?: string }> | undefined;
      if (!desiredState?.framework || !planGraph || !validation) {
        return { ok: true };
      }

      const strictApprovals = (desiredState.framework.spec.strictApprovals as string | undefined) ?? "powerful";
      const services = new Map<string, GatedService>();

      for (const [serviceId, servicePlan] of Object.entries(planGraph.servicePlans)) {
        const classification = validation[serviceId];
        if (!classification) continue;

        const requiresApproval = classification.tier === "powerful" || strictApprovals === "all";
        if (!requiresApproval) continue;

        const projectionHash =
          classification.projectionHash ?? computePowerfulProjectionHash(projectionInputFor(serviceId, servicePlan as ContainerSpec));
        const approved = deps.store.isApproved(projectionHash);

        services.set(serviceId, {
          serviceId,
          tier: classification.tier as "baseline" | "powerful",
          projectionHash,
          humanRendering: humanRender(servicePlan as ContainerSpec),
          approved,
        });
      }

      holder.services = services;
      ctx.gateSnapshot = services;
      return { ok: true };
    },
  };
}
