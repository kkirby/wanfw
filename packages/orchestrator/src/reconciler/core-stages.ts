import type { StateStore } from "../state-store/store.js";
import { loadDesiredState, type DesiredState } from "../desired-state/index.js";
import { resolveDependencies, type FrameworkSpec } from "../dependency-resolution/index.js";
import type { NamedStage, ReconcileRunContext, StageResult } from "./types.js";

export interface CoreStagesDeps {
  desiredDir: string;
  bundlesDir: string;
  store: StateStore;
}

/** load + migrate (§7): loadDesiredState already runs the migration chain in memory (T3.1). */
export function buildLoadStage(deps: CoreStagesDeps): NamedStage {
  return {
    name: "load",
    run: async (ctx: ReconcileRunContext): Promise<StageResult> => {
      try {
        const desiredState = await loadDesiredState(deps.desiredDir);
        ctx.desiredState = desiredState;
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
