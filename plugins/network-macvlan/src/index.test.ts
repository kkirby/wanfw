import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, probeTask, planTask } from "./index.js";

describe("network-macvlan plugin (§8.4, ADR-1)", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("network-macvlan");
  });

  describe("probe", () => {
    it("declines immediately when no default-route interface was detected, without ever calling probeNetwork", async () => {
      let called = false;
      const probeNetwork = async () => {
        called = true;
        return { ok: true };
      };
      const result = await probeTask({}, probeNetwork);
      expect(result).toEqual({ ok: false, reason: "could not detect the host's default-route network interface" });
      expect(called).toBe(false);
    });

    it("accepts when the core-mediated probeNetwork check succeeds", async () => {
      const result = await probeTask({ defaultRouteInterface: "eth0" }, async (mode, parent) => {
        expect(mode).toBe("macvlan");
        expect(parent).toBe("eth0");
        return { ok: true };
      });
      expect(result).toEqual({ ok: true });
    });

    it("declines with the real Docker-daemon reason when probeNetwork fails (a VPS-like environment)", async () => {
      const result = await probeTask({ defaultRouteInterface: "eth0" }, async () => ({
        ok: false,
        reason: "Error response from daemon: could not find an available, non-overlapping IPv4 address pool",
      }));
      expect(result).toEqual({
        ok: false,
        reason: "Error response from daemon: could not find an available, non-overlapping IPv4 address pool",
      });
    });

    it("falls back to a generic reason if probeNetwork fails without one", async () => {
      const result = await probeTask({ defaultRouteInterface: "eth0" }, async () => ({ ok: false }));
      expect(result).toEqual({ ok: false, reason: "macvlan is not usable on interface 'eth0'" });
    });
  });

  describe("plan", () => {
    it("builds a macvlan NetworkPlan with the allocated static IP, dedicatedL2/hostIsolated/hairpinCaveat all true", async () => {
      const plan = await planTask({ purpose: "shared-proxy", ports: [443, 80], stableAddress: true }, "eth0", async () => "192.168.1.242");

      expect(plan.resources).toEqual([{ name: "wanfw_exposure", driver: "macvlan", parent: "eth0" }]);
      expect(plan.attachment).toEqual({ network: "wanfw_exposure", ip: "192.168.1.242" });
      expect(plan.endpoint).toEqual({ kind: "dedicated-ip", ip: "192.168.1.242" });
      expect(plan.properties).toEqual({ hostIsolated: true, dedicatedL2: true, hairpinCaveat: true });
    });

    it("operatorInstructions names the exact forward target and the hairpin shim recipe (§8.4)", async () => {
      const plan = await planTask({ purpose: "shared-proxy", ports: [443, 80], stableAddress: true }, "eth0", async () => "192.168.1.242");

      expect(plan.operatorInstructions).toContain("forward WAN:443 -> 192.168.1.242:443");
      expect(plan.operatorInstructions).toContain("ip link add");
      expect(plan.operatorInstructions).toContain("type macvlan");
      expect(plan.operatorInstructions).toContain("eth0");
    });

    it("calls allocateIp exactly once and uses its result throughout the plan", async () => {
      let calls = 0;
      const plan = await planTask({ purpose: "shared-proxy", ports: [443], stableAddress: true }, "wlan0", async () => {
        calls += 1;
        return "10.0.5.5";
      });
      expect(calls).toBe(1);
      expect(plan.attachment.ip).toBe("10.0.5.5");
      expect(plan.endpoint.ip).toBe("10.0.5.5");
    });
  });
});
