import type { ProbeContext, ProbeNetworkFn, ProbeResult } from "./types.js";

/**
 * probe (ADR-1): declines immediately if no default-route interface was
 * ever detected (nothing to attempt macvlan against), otherwise defers
 * entirely to the core-mediated `net.probeNetwork` feasibility check --
 * this function has no opinion of its own about *why* macvlan would fail
 * on a given host (MAC filtering, no promiscuous mode, a WiFi uplink,
 * etc.); the Docker daemon's own real attempt is the only source of truth,
 * and its error message is passed through as the decline reason verbatim
 * rather than re-interpreted, so operators see the real underlying cause.
 */
export async function probeTask(ctx: ProbeContext, probeNetwork: ProbeNetworkFn): Promise<ProbeResult> {
  if (!ctx.defaultRouteInterface) {
    return { ok: false, reason: "could not detect the host's default-route network interface" };
  }
  const result = await probeNetwork("macvlan", ctx.defaultRouteInterface);
  if (!result.ok) {
    return { ok: false, reason: result.reason ?? `macvlan is not usable on interface '${ctx.defaultRouteInterface}'` };
  }
  return { ok: true };
}
