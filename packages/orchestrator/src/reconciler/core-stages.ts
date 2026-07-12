import type { StateStore } from "../state-store/store.js";
import { loadDesiredState, type DesiredState } from "../desired-state/index.js";
import { resolveDependencies, type FrameworkSpec } from "../dependency-resolution/index.js";
import type { NamedStage, ReconcileRunContext, StageResult } from "./types.js";

/** Mutable holder for the framework doc's current role bindings (§5.3), read live by the T4.3 DNS broker to find the bound dnsProvider without threading desired state through the host API dispatcher. */
export interface FrameworkRolesHolder {
  roles: Record<string, string>;
}

export interface CoreStagesDeps {
  desiredDir: string;
  bundlesDir: string;
  store: StateStore;
  rolesHolder?: FrameworkRolesHolder;
}

/** load + migrate (§7): loadDesiredState already runs the migration chain in memory (T3.1). */
export function buildLoadStage(deps: CoreStagesDeps): NamedStage {
  return {
    name: "load",
    run: async (ctx: ReconcileRunContext): Promise<StageResult> => {
      try {
        const desiredState = await loadDesiredState(deps.desiredDir);
        ctx.desiredState = desiredState;
        if (deps.rolesHolder) {
          deps.rolesHolder.roles = (desiredState.framework?.spec.roles as Record<string, string> | undefined) ?? {};
        }
        // ipam range sync (T5.1, ADR-1): keeps `ipam_ranges` in `wanfw_state`
        // matching `framework.spec.network.macvlan` on every load, so
        // `network-macvlan`'s later `ipam.allocate("macvlan")` host-API
        // call always has a range to allocate against without this stage
        // (or any other) needing to thread the framework doc through to
        // the dispatcher separately -- same "sync from desired state on
        // load" shape as `rolesHolder` just above.
        const macvlan = (desiredState.framework?.spec.network as { macvlan?: { reservedCidr?: string; gateway?: string } } | undefined)
          ?.macvlan;
        if (macvlan?.reservedCidr && macvlan.gateway) {
          deps.store.setIpamRange({ id: "macvlan", cidr: macvlan.reservedCidr, gateway: macvlan.gateway });
        }
        if (desiredState.errors.length > 0) {
          return {
            ok: false,
            error: {
              stage: "load",
              message: `${desiredState.errors.length} document(s) failed to load: ${desiredState.errors
                .map((e) => e.message)
                .join("; ")}`,
            },
          };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: { stage: "load", message: (err as Error).message } };
      }
    },
  };
}

/** resolve (§7): dependency-graph resolution (T3.3), config-time errors surfaced per-plugin. */
export function buildResolveStage(deps: CoreStagesDeps): NamedStage {
  return {
    name: "resolve",
    run: async (ctx: ReconcileRunContext): Promise<StageResult> => {
      const desiredState = ctx.desiredState as DesiredState | undefined;
      if (!desiredState?.framework) {
        return { ok: true }; // pre-init state: nothing to resolve yet
      }
      const result = await resolveDependencies(deps.store, deps.bundlesDir, desiredState.framework.spec as FrameworkSpec);
      if (!result.ok) {
        const first = result.errors[0]!;
        return {
          ok: false,
          error: { stage: "resolve", plugin: first.pluginId, message: first.message },
        };
      }
      return { ok: true };
    },
  };
}

/**
 * Placeholder stages for PLAN/VALIDATE/GATE/EXECUTE/OBSERVE (T3.5-T3.9).
 * Each trivially succeeds so the full pipeline shape is real and testable
 * end to end before those stages have real bodies; replaced one at a time
 * as their owning tasks land.
 */
export function buildPlaceholderStage(name: string): NamedStage {
  return {
    name,
    run: async (): Promise<StageResult> => ({ ok: true }),
  };
}
