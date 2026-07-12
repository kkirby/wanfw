import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";
import { ReconcileEngine } from "./engine.js";
import type { NamedStage, ReconcileOutcome } from "./types.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("ReconcileEngine", () => {
  it("runs every stage in order on a successful pipeline and reports phase=live", async () => {
    const order: string[] = [];
    const stages: NamedStage[] = [
      { name: "load", run: async () => (order.push("load"), { ok: true }) },
      { name: "resolve", run: async () => (order.push("resolve"), { ok: true }) },
      { name: "plan", run: async () => (order.push("plan"), { ok: true }) },
    ];
    const outcomes: ReconcileOutcome[] = [];
    const engine = new ReconcileEngine({ stages, log: createLogger("test"), onOutcome: (o) => outcomes.push(o) });

    await engine.trigger("test");

    expect(order).toEqual(["load", "resolve", "plan"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.phase).toBe("live");
  });

  it("stops the pipeline at the first failing stage and reports the structured error", async () => {
    const order: string[] = [];
    const stages: NamedStage[] = [
      { name: "load", run: async () => (order.push("load"), { ok: true }) },
      {
        name: "resolve",
        run: async () => (
          order.push("resolve"), { ok: false, error: { stage: "resolve", plugin: "deploy-docker", message: "missing role" } }
        ),
      },
      { name: "plan", run: async () => (order.push("plan"), { ok: true }) },
    ];
    const outcomes: ReconcileOutcome[] = [];
    const engine = new ReconcileEngine({ stages, log: createLogger("test"), onOutcome: (o) => outcomes.push(o) });

    await engine.trigger("test");

    expect(order).toEqual(["load", "resolve"]); // plan never runs
    expect(outcomes[0]?.phase).toBe("error");
    expect(outcomes[0]?.lastError).toEqual({ stage: "resolve", plugin: "deploy-docker", message: "missing role" });
  });

  it("a stage that throws is treated as a structured failure, not an uncaught exception", async () => {
    const stages: NamedStage[] = [
      {
        name: "load",
        run: async () => {
          throw new Error("disk exploded");
        },
      },
    ];
    const outcomes: ReconcileOutcome[] = [];
    const engine = new ReconcileEngine({ stages, log: createLogger("test"), onOutcome: (o) => outcomes.push(o) });

    await expect(engine.trigger("test")).resolves.toBeUndefined();
    expect(outcomes[0]?.phase).toBe("error");
    expect(outcomes[0]?.lastError?.message).toBe("disk exploded");
  });

  it("coalesces a burst of triggers arriving while a reconcile is in flight into exactly one extra run", async () => {
    const gate = deferred<void>();
    let entries = 0;
    const stages: NamedStage[] = [
      {
        name: "slow",
        run: async () => {
          entries += 1;
          if (entries === 1) await gate.promise; // first run blocks until we release it
          return { ok: true };
        },
      },
    ];
    const engine = new ReconcileEngine({ stages, log: createLogger("test") });

    const first = engine.trigger("a");
    // Burst of triggers while the first run is still blocked mid-flight.
    engine.trigger("b");
    engine.trigger("c");
    engine.trigger("d");
    engine.trigger("e");

    gate.resolve();
    await first;

    // One run for the initial trigger, one coalesced run for the whole
    // burst that arrived while it was in flight -- not one run per trigger.
    expect(engine.getRunCount()).toBe(2);
  });

  it("runs are strictly serialized: a second burst after the first fully completes starts a fresh run", async () => {
    const stages: NamedStage[] = [{ name: "fast", run: async () => ({ ok: true }) }];
    const engine = new ReconcileEngine({ stages, log: createLogger("test") });

    await engine.trigger("a");
    await engine.trigger("b");

    expect(engine.getRunCount()).toBe(2);
  });
});
