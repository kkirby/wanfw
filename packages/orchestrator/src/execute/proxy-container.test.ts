import { describe, expect, it } from "vitest";
import { buildProxyContainerSpec, proxyNetworksFrom } from "./proxy-container.js";

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

    expect(spec.image).toBe("caddy:2");
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
});
