import type { EndpointRequest, NetworkPlan } from "./types.js";

const EXPOSURE_NETWORK = "wanfw_exposure";

/**
 * plan (ADR-1): dedicated bridge network for the proxy, publishing the
 * requested ports on the host. `properties` are all false -- this provider
 * has no L2 isolation, no host-stack invisibility, and no hairpin caveat
 * (bridge-published ports are reachable from the host directly), which is
 * exactly what makes it the safe/simple default versus network-macvlan.
 */
export function planTask(req: EndpointRequest): NetworkPlan {
  return {
    resources: [{ name: EXPOSURE_NETWORK, driver: "bridge" }],
    attachment: { network: EXPOSURE_NETWORK },
    endpoint: {
      kind: "host-ports",
      ports: req.ports.map((port) => ({ containerPort: port, hostPort: port })),
    },
    properties: { hostIsolated: false, dedicatedL2: false, hairpinCaveat: false },
    operatorInstructions: "forward WAN:443 -> <host-LAN-IP>:443",
  };
}
