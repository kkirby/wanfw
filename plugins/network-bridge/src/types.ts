/** ADR-1's NetworkProvider contract, in the JSON-serializable shapes the RPC boundary requires. */

export interface ProbeContext {
  /** Host port availability, precomputed by the orchestrator (it can locally test-bind; a plugin cannot reach the host network namespace to check itself). */
  portAvailability: Record<string, boolean>;
}

export interface ProbeResult {
  ok: boolean;
  reason?: string;
}

export interface EndpointRequest {
  purpose: "shared-proxy" | "dedicated-proxy";
  ports: number[];
  stableAddress: boolean;
}

export interface DockerNetworkSpec {
  name: string;
  driver: "bridge";
}

export interface PortMap {
  containerPort: number;
  hostPort: number;
}

export interface NetworkPlan {
  resources: DockerNetworkSpec[];
  attachment: { network: string };
  endpoint: { kind: "host-ports"; ports: PortMap[] };
  properties: { hostIsolated: boolean; dedicatedL2: boolean; hairpinCaveat: boolean };
  operatorInstructions: string;
}
