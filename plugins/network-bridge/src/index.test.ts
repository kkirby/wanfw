import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, probeTask, planTask } from "./index.js";

describe("network-bridge plugin (ADR-1)", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("network-bridge");
  });

  describe("probe", () => {
    it("passes when 443 and 80 are both available", () => {
      const result = probeTask({ portAvailability: { "443": true, "80": true } });
      expect(result).toEqual({ ok: true });
    });

    it("declines with a reason when a required port is busy", () => {
      const result = probeTask({ portAvailability: { "443": false, "80": true } });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("443");
    });

    it("declines and names every busy port when more than one is taken", () => {
      const result = probeTask({ portAvailability: { "443": false, "80": false } });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("443");
      expect(result.reason).toContain("80");
    });
  });

  describe("plan", () => {
    it("returns a shared-bridge NetworkPlan shaped exactly per ADR-1's NetworkPlan interface", () => {
      const plan = planTask({ purpose: "shared-proxy", ports: [443, 80], stableAddress: true });

      expect(plan.resources).toEqual([{ name: "wanfw_exposure", driver: "bridge" }]);
      expect(plan.attachment).toEqual({ network: "wanfw_exposure" });
      expect(plan.endpoint).toEqual({
        kind: "host-ports",
        ports: [
          { containerPort: 443, hostPort: 443 },
          { containerPort: 80, hostPort: 80 },
        ],
      });
      expect(plan.properties).toEqual({ hostIsolated: false, dedicatedL2: false, hairpinCaveat: false });
      expect(typeof plan.operatorInstructions).toBe("string");
      expect(plan.operatorInstructions.length).toBeGreaterThan(0);
    });

    it("consumers key off endpoint/properties only -- the plan carries no provider-identifying field", () => {
      const plan = planTask({ purpose: "shared-proxy", ports: [443], stableAddress: true });
      const keys = Object.keys(plan).sort();
      expect(keys).toEqual(["attachment", "endpoint", "operatorInstructions", "properties", "resources"]);
    });
  });
});
