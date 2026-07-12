import type { EndpointRequest, NetworkPlan } from "./types.js";

const EXPOSURE_NETWORK = "wanfw_exposure";

/**
 * plan (ADR-1): a macvlan network on the host's default-route interface,
 * with the proxy given a static IP allocated from the reserved range
 * (T5.1's `ipam.allocate`, "implicit for network-provider plugins" --
 * no capability grant needed for that specific call). `properties` are
 * the inverse of `network-bridge`'s: real L2 isolation and host-stack
 * invisibility, at the cost of the hairpin caveat (the host itself cannot
 * reach the macvlan IP without an `ip link add ... type macvlan` shim on
 * the host, since a macvlan parent interface cannot talk to its own
 * macvlan children by design -- documented for operators in
 * `operatorInstructions`, and this is exactly why EXECUTE's own health
 * checks run over `wanfw_svc_*` networks rather than the exposure IP,
 * per §8.4).
 */
export async function planTask(req: EndpointRequest, parent: string, allocateIp: () => Promise<string>): Promise<NetworkPlan> {
  const ip = await allocateIp();
  return {
    resources: [{ name: EXPOSURE_NETWORK, driver: "macvlan", parent }],
    attachment: { network: EXPOSURE_NETWORK, ip },
    endpoint: { kind: "dedicated-ip", ip },
    properties: { hostIsolated: true, dedicatedL2: true, hairpinCaveat: true },
    operatorInstructions: `forward WAN:443 -> ${ip}:443. Host-to-proxy hairpin note: the host itself cannot reach ${ip} directly (macvlan parents can't talk to their own macvlan children) -- if you need to reach it from the host for debugging, add a shim: ip link add macvlan-shim link ${parent} type macvlan mode bridge && ip addr add <free-ip-on-the-same-subnet>/32 dev macvlan-shim && ip link set macvlan-shim up. Requested ports (${req.ports.join(", ")}) are not published on the host at all -- they only exist on the dedicated IP.`,
  };
}
