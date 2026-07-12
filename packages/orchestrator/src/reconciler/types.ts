import type { DesiredState } from "../desired-state/index.js";

export interface StageError {
  stage: string;
  plugin?: string;
  message: string;
}

/** Mutable context threaded through the stage pipeline; each stage may read and add to it. */
export interface ReconcileRunContext {
  desiredState?: DesiredState;
  [key: string]: unknown;
}

export interface StageResult {
  ok: boolean;
  error?: StageError;
}

export type Stage = (ctx: ReconcileRunContext) => Promise<StageResult>;

export interface NamedStage {
  name: string;
  run: Stage;
}

export type ReconcilePhase = "reconciling" | "live" | "degraded" | "error";

export interface ReconcileOutcome {
  phase: ReconcilePhase;
  lastError?: StageError;
  completedAt: string;
}
