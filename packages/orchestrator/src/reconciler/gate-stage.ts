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
  /** T6.1: unmissable banner lines for catastrophic grants and/or tier1 self-exposure (ADR-4, ADR-7); empty when neither applies. */
  banners: string[];
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

const CATASTROPHIC_BANNER = "**This grant is equivalent to root on the host**";
const SELF_EXPOSURE_BANNER =
  "**You are exposing the control plane of this system to the WAN, behind password auth only** (ADR-7: tier1 is hardened to LAN-threat standard, not exposed-app standard)";

const DISK_BLOCK_DEVICE = /^\/dev\/(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)(\d+)?$/;

/**
 * T6.1: known-catastrophic grant patterns get an unmissable banner alongside
 * the normal projection, on top of (never instead of) the ordinary powerful-
 * tier approval gate -- ADR-4 "nothing is inexpressible" means these are
 * still approvable, just never silently so.
 */
function catastrophicBanners(spec: ContainerSpec): string[] {
  const reasons: string[] = [];
  for (const mount of spec.mounts ?? []) {
    if (mount.type === "bind" && mount.source === "/var/run/docker.sock") {
      reasons.push("bind-mounts the Docker socket");
    }
  }
  if (spec.privileged) reasons.push("runs privileged");
  if (spec.networkMode === "host" && (spec.capAdd ?? []).includes("NET_ADMIN")) {
    reasons.push("host networking + NET_ADMIN");
  }
  for (const device of spec.devices ?? []) {
    if (device === "/dev/mem") reasons.push("accesses /dev/mem (raw physical memory)");
    else if (DISK_BLOCK_DEVICE.test(device)) reasons.push(`accesses raw disk block device ${device}`);
  }
  return reasons.length > 0 ? [`${CATASTROPHIC_BANNER}: ${reasons.join("; ")}`] : [];
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

        // ADR-7 self-exposure: a service document literally named "tier1"
        // is force-classified powerful regardless of what it emits, with
        // its own dedicated banner -- never blocked, just never silent.
        const selfExposure = serviceId === "tier1";
        const tier: "baseline" | "powerful" = selfExposure ? "powerful" : (classification.tier as "baseline" | "powerful");

        const requiresApproval = tier === "powerful" || strictApprovals === "all";
        if (!requiresApproval) continue;

        const projectionHash =
          classification.projectionHash ?? computePowerfulProjectionHash(projectionInputFor(serviceId, servicePlan as ContainerSpec));
        const approved = deps.store.isApproved(projectionHash);

        const banners = catastrophicBanners(servicePlan as ContainerSpec);
        if (selfExposure) banners.push(SELF_EXPOSURE_BANNER);

        services.set(serviceId, {
          serviceId,
          tier,
          projectionHash,
          humanRendering: humanRender(servicePlan as ContainerSpec),
          approved,
          banners,
        });
      }

      holder.services = services;
      ctx.gateSnapshot = services;
      return { ok: true };
    },
  };
}
