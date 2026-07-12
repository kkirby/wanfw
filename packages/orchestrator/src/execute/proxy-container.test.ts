import { describe, expect, it } from "vitest";
import { buildProxyContainerSpec, proxyNetworksFrom, exposureNetworkDriverOptions } from "./proxy-container.js";

describe("proxy-container (§8.4, ADR-9 core-emitted proxy)", () => {
  it("derives the exposure network, per-service networks, and host ports from a network-bridge-shaped NetworkPlan", () => {
    const networkPlan = {
      resources: [{ name: "wanfw_exposure", driver: "bridge" as const }],
      attachment: { network: "wanfw_exposure" },
      endpoint: { kind: "host-ports" as const, ports: [{ containerPort: 443, hostPort: 443 }, { containerPort: 80, hostPort: 80 }] },
      properties: { hostIsolated: false, dedicatedL2: false, hairpinCaveat: false },
      operatorInstructions: "x",
    };

    const { exposureNetwork, serviceNetworks, hostPorts } = proxyNetworksFrom(networkPlan, ["jellyfin", "kavita"]);

    expect(exposureNetwork).toBe("wanfw_exposure");
    expect(serviceNetworks).toEqual(["wanfw_svc_jellyfin", "wanfw_svc_kavita"]);
    expect(hostPorts).toEqual([443, 80]);
  });

  it("builds a proxy ContainerSpec dual-homed onto the exposure network plus every service network, read-only cert/proxycfg mounts", () => {
    const spec = buildProxyContainerSpec(
      "wanfw_exposure",
      ["wanfw_svc_jellyfin", "wanfw_svc_kavita"],
      [443, 80],
      "wanfw_wanfw_certs",
      "wanfw_wanfw_proxycfg",
    );

    expect(spec.image).toMatch(/^caddy@sha256:/); // T6.3: pinned by digest
    expect(spec.networks).toEqual(["wanfw_exposure", "wanfw_svc_jellyfin", "wanfw_svc_kavita"]);
    expect(spec.ports).toEqual([443, 80]);
    expect(spec.mounts).toEqual([
      { type: "volume", source: "wanfw_wanfw_certs", target: "/data/certs", readOnly: true },
      { type: "volume", source: "wanfw_wanfw_proxycfg", target: "/etc/caddy", readOnly: true },
    ]);
  });

  it("passes the real (project-prefixed) volume names through verbatim, whatever the caller supplies", () => {
    const spec = buildProxyContainerSpec("net", [], [], "some-other-certs-vol", "some-other-proxycfg-vol");
    expect(spec.mounts).toEqual([
      { type: "volume", source: "some-other-certs-vol", target: "/data/certs", readOnly: true },
      { type: "volume", source: "some-other-proxycfg-vol", target: "/etc/caddy", readOnly: true },
    ]);
  });

  describe("exposureNetworkDriverOptions (real-hardware macvlan fix)", () => {
    it("pulls macvlan's driver/parent/subnet/gateway out of the plan's resources list by name", () => {
      const networkPlan = {
        resources: [{ name: "wanfw_exposure", driver: "macvlan", parent: "eth0", ipamSubnet: "192.168.1.240/29", ipamGateway: "192.168.1.241" }],
        attachment: { network: "wanfw_exposure" },
      };
      expect(exposureNetworkDriverOptions(networkPlan, "wanfw_exposure")).toEqual({
        driver: "macvlan",
        parent: "eth0",
        subnet: "192.168.1.240/29",
        gateway: "192.168.1.241",
      });
    });

    it("returns undefined for a bridge-shaped plan with no resources entry -- Docker defaults to bridge, unchanged from before this fix", () => {
      const networkPlan = { attachment: { network: "wanfw_exposure" } };
      expect(exposureNetworkDriverOptions(networkPlan, "wanfw_exposure")).toBeUndefined();
    });

    it("returns undefined when there is no exposure network name at all", () => {
      expect(exposureNetworkDriverOptions(undefined, undefined)).toBeUndefined();
    });

    it("returns undefined when the resources list doesn't contain a matching name", () => {
      const networkPlan = { resources: [{ name: "some-other-network", driver: "macvlan" }] };
      expect(exposureNetworkDriverOptions(networkPlan, "wanfw_exposure")).toBeUndefined();
    });
  });
});
