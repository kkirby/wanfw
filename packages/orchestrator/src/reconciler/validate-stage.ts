import type { StateStore } from "../state-store/store.js";
import type { DesiredState } from "../desired-state/index.js";
import { validateContainerSpec, loadGrantsForPlugin, type ContainerSpec } from "../validate/index.js";
import type { NamedStage, ReconcileRunContext, StageResult } from "./types.js";
import type { PlanGraph } from "./plan-stage.js";

export interface ValidateStageDeps {
  store: StateStore;
}

function boundDeployPluginId(desiredState: DesiredState, serviceId: string): string | undefined {
  const service = desiredState.services.get(serviceId);
  const deploy = service?.spec.deploy as { plugin?: string } | undefined;
  return deploy?.plugin;
}

/**
 * VALIDATE stage (§7 VALIDATE, T3.6): field-level capability check of
 * every service's deploy plan (from PLAN's `servicePlans`) against the
 * emitting plugin's *stored* grants -- the confused-deputy defense (ADR-4):
 * a plugin can be trusted and honest and still emit a plan the operator
 * never authorized, because the plan reflects config a compromised tier1
 * could have written. The grant scope, not plugin trust, is what stops it.
 */
export function buildValidateStage(deps: ValidateStageDeps): NamedStage {
  return {
    name: "validate",
    run: async (ctx: ReconcileRunContext): Promise<StageResult> => {
      const desiredState = ctx.desiredState as DesiredState | undefined;
      const planGraph = ctx.planGraph as PlanGraph | undefined;
      if (!desiredState || !planGraph) {
        return { ok: true }; // nothing planned yet (pre-init, or PLAN produced nothing)
      }

      const classifications: Record<string, { tier: string; projectionHash?: string }> = {};

      for (const [serviceId, servicePlan] of Object.entries(planGraph.servicePlans)) {
        const pluginId = boundDeployPluginId(desiredState, serviceId);
        if (!pluginId) {
          return { ok: false, error: { stage: "validate", plugin: serviceId, message: `service ${serviceId} has no deploy plugin bound` } };
        }
        const grants = loadGrantsForPlugin(deps.store, pluginId);
        const result = validateContainerSpec(serviceId, servicePlan as ContainerSpec, grants);

        if (!result.ok) {
          const first = result.violations[0]!;
          return {
            ok: false,
            error: {
              stage: "validate",
              plugin: pluginId,
              message: `service ${serviceId}: ${first.message}`,
            },
          };
        }

        classifications[serviceId] = { tier: result.tier, projectionHash: result.projectionHash };
      }

      ctx.validation = classifications;
      return { ok: true };
    },
  };
}
