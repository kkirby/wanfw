import type { Logger } from "../logger.js";
import type { NamedStage, ReconcileOutcome, ReconcileRunContext, StageError } from "./types.js";

export interface ReconcileEngineOptions {
  stages: NamedStage[];
  log: Logger;
  onOutcome?: (outcome: ReconcileOutcome) => void;
}

/**
 * Level-triggered reconcile loop (§7): trigger sources call `trigger()`
 * (desired-state change, 60s timer, nudge/CLI actions; Docker events and
 * cert-renewal scheduling land with T3.8/T4.6, which is what actually
 * produces those trigger sources). Single reconcile runs at a time; any
 * triggers that arrive while one is in flight coalesce into at most one
 * more run afterward (not one-per-trigger) -- "queued triggers coalesce."
 *
 * The stage pipeline itself (load -> migrate -> resolve -> PLAN -> VALIDATE
 * -> GATE -> EXECUTE -> OBSERVE) is supplied by the caller as an ordered
 * list of named stages; each stage returns ok/error rather than throwing,
 * and a failing stage stops the pipeline for that run without crashing the
 * engine -- the next trigger tries again from the top (no imperative replay,
 * matching the idempotency contract EXECUTE will implement in T3.8).
 */
export class ReconcileEngine {
  private stages: NamedStage[];
  private log: Logger;
  private onOutcome?: (outcome: ReconcileOutcome) => void;
  private runningPromise: Promise<void> | null = null;
  private pendingRerun = false;
  private runCount = 0;

  constructor(options: ReconcileEngineOptions) {
    this.stages = options.stages;
    this.log = options.log;
    this.onOutcome = options.onOutcome;
  }

  getRunCount(): number {
    return this.runCount;
  }

  /** Schedules a reconcile. Safe to call from any trigger source, any number of times. */
  trigger(source: string): Promise<void> {
    this.log.info("reconcile triggered", { source });
    if (this.runningPromise) {
      this.pendingRerun = true;
      return this.runningPromise;
    }
    this.runningPromise = (async () => {
      do {
        this.pendingRerun = false;
        await this.runOnce();
      } while (this.pendingRerun);
      this.runningPromise = null;
    })();
    return this.runningPromise;
  }

  private async runOnce(): Promise<void> {
    this.runCount += 1;
    const ctx: ReconcileRunContext = {};
    let lastError: StageError | undefined;

    for (const stage of this.stages) {
      let result;
      try {
        result = await stage.run(ctx);
      } catch (err) {
        result = { ok: false, error: { stage: stage.name, message: (err as Error).message } };
      }
      if (!result.ok) {
        lastError = result.error;
        this.log.warn("reconcile stage failed", { stage: stage.name, error: result.error });
        break;
      }
    }

    const outcome: ReconcileOutcome = lastError
      ? { phase: "error", lastError, completedAt: new Date().toISOString() }
      : { phase: "live", completedAt: new Date().toISOString() };

    this.onOutcome?.(outcome);
  }
}
