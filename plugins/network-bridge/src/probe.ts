import type { ProbeContext, ProbeResult } from "./types.js";

const REQUIRED_PORTS = [443, 80];

/**
 * probe (ADR-1): reports whether the shared bridge network + host-port
 * publish approach can function here. The orchestrator precomputes host
 * port availability (a plugin has no host network namespace access to test
 * this itself) and passes it in `ProbeContext.portAvailability`.
 */
export function probeTask(ctx: ProbeContext): ProbeResult {
  const busy = REQUIRED_PORTS.filter((port) => ctx.portAvailability[String(port)] === false);
  if (busy.length > 0) {
    return { ok: false, reason: `port(s) ${busy.join(", ")} already in use on the host` };
  }
  return { ok: true };
}
