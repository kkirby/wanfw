/** ADR-1's NetworkProvider contract, macvlan variant, in the JSON-serializable shapes the RPC boundary requires. */

export interface ProbeContext {
  /**
   * The host's default-route network interface (e.g. `"eth0"`), detected
   * by whoever calls probe() -- in practice the wizard (T5.3), which runs
   * inside the orchestrator and has a real host-network diagnostic path
   * this plugin's sandboxed, network-isolated child process does not
   * (§12.5: pluginhost children have no host network namespace access at
   * all). Absent means detection itself failed upstream, which is always
   * a decline here -- there is no interface to attempt macvlan against.
   */
  defaultRouteInterface?: string;
}

export interface ProbeResult {
  ok: boolean;
  reason?: string;
}

/**
 * The core-mediated feasibility check (§8.4's own wording: "macvlan
 * feasibility via the core-mediated `net.probeNetwork` helper"): only the
 * orchestrator holds `/var/run/docker.sock` (§12.5), so only it can ask
 * the Docker daemon to actually attempt a macvlan network against a real
 * parent interface -- the daemon validates promiscuous-mode/MAC-filtering
 * capability against the *host's* real NIC regardless of the caller's own
 * network namespace, which is what makes this check meaningful even though
 * the orchestrator container itself has no network access (`network_mode:
 * "none"`, §12.5's own invariant).
 */
export type ProbeNetworkFn = (mode: "macvlan", parent: string) => Promise<{ ok: boolean; reason?: string }>;

export interface EndpointRequest {
  purpose: "shared-proxy" | "dedicated-proxy";
  ports: number[];
  stableAddress: boolean;
}

export interface DockerNetworkSpec {
  name: string;
  driver: "macvlan";
  parent: string;
  /** The reserved range's own subnet/gateway (T5.1's `framework.spec.network.macvlan`), required by Docker's real macvlan driver -- found missing entirely by live verification against real hardware: without these, EXECUTE had nothing but a bare `driver`/`parent` to create the network with, and Docker's API accepted that silently by falling back to an ordinary bridge network instead of erroring. */
  ipamSubnet: string;
  ipamGateway: string;
}

export interface NetworkPlan {
  resources: DockerNetworkSpec[];
  attachment: { network: string; ip: string };
  endpoint: { kind: "dedicated-ip"; ip: string };
  properties: { hostIsolated: boolean; dedicatedL2: boolean; hairpinCaveat: boolean };
  operatorInstructions: string;
}
