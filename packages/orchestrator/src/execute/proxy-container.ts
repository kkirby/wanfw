import type { ContainerSpec } from "../validate/index.js";

export const PROXY_CONTAINER_NAME = "wanfw-proxy";
const PROXY_IMAGE = "caddy:2"; // TODO(T6.3): pin digest

export interface NetworkPlanLike {
  attachment?: { network?: string };
  endpoint?: { kind?: string; ports?: Array<{ hostPort: number }> };
}

/**
 * Core-emitted proxy ContainerSpec (§8.4, ADR-9): `caddy:2.x`, read-only
 * mounts of the compose-managed `wanfw_certs`/`wanfw_proxycfg` volumes --
 * core authority only *attaches* to them, it doesn't create/own them --
 * dual-homed onto the exposure network plus every `wanfw_svc_<id>` network
 * so health checks and reload never depend on the WAN-facing path (§8.4).
 * This spec is emitted by the orchestrator itself, not a plugin -- it goes
 * through `validateCoreEmittedSpec` (T3.6) for classification/audit, never
 * plugin grant checks, and is never written to the compose file.
 *
 * `certsVolumeName`/`proxycfgVolumeName` are passed in rather than
 * hardcoded (T4.7 fix, found by live verification): Docker Compose always
 * names a project's volumes `<project>_<key>` -- `docker-compose.yml`
 * declares `name: wanfw` plus volume keys `wanfw_certs`/`wanfw_proxycfg`,
 * so the *actual* volumes that exist are `wanfw_wanfw_certs`/
 * `wanfw_wanfw_proxycfg`, not the bare literal this function used to
 * mount by. That mismatch didn't error -- the Docker API silently
 * auto-creates a new, empty, never-written-to volume under an unrecognized
 * name instead of failing -- so the proxy container ran for multiple
 * milestones' worth of live verification quietly serving Caddy's own
 * built-in sample config from a phantom volume, never the framework's
 * real one. `main.ts` passes the real names computed once, in one place.
 */
export function buildProxyContainerSpec(
  exposureNetwork: string,
  serviceNetworks: string[],
  hostPorts: number[],
  certsVolumeName: string,
  proxycfgVolumeName: string,
): ContainerSpec {
  return {
    image: PROXY_IMAGE,
    mounts: [
      { type: "volume", source: certsVolumeName, target: "/data/certs", readOnly: true },
      { type: "volume", source: proxycfgVolumeName, target: "/etc/caddy", readOnly: true },
    ],
    ports: hostPorts,
    networks: [exposureNetwork, ...serviceNetworks],
    restart: "unless-stopped",
  };
}

export function proxyNetworksFrom(networkPlan: NetworkPlanLike | undefined, serviceIds: string[]): {
  exposureNetwork: string | undefined;
  serviceNetworks: string[];
  hostPorts: number[];
} {
  const exposureNetwork = networkPlan?.attachment?.network;
  const hostPorts = networkPlan?.endpoint?.kind === "host-ports" ? (networkPlan.endpoint.ports ?? []).map((p) => p.hostPort) : [];
  const serviceNetworks = serviceIds.map((id) => `wanfw_svc_${id}`);
  return { exposureNetwork, serviceNetworks, hostPorts };
}
