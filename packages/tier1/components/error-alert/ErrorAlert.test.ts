import { describe, expect, it } from "vitest";
import { PHASE_COLOR } from "./ErrorAlert";

describe("PHASE_COLOR", () => {
  it("has a color for every ServicePhase the orchestrator can report (observe-stage.ts's ServicePhase union)", () => {
    const servicePhases = ["pending", "reconciling", "live", "degraded", "pending-approval", "error"];
    for (const phase of servicePhases) {
      expect(PHASE_COLOR[phase]).toBeDefined();
    }
  });
});
