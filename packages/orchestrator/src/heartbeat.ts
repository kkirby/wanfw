import { atomicWriteFile } from "@wanfw/core-schemas";

export const ORCHESTRATOR_VERSION = "0.1.0";

export type FrameworkPhase = "pending-init" | "reconciling" | "live" | "degraded" | "error";

export interface FrameworkStatus {
  phase: FrameworkPhase;
  ts: string;
  version: string;
}

export interface HeartbeatState {
  current: FrameworkStatus;
}

/**
 * Writes wanfw_status/framework.json atomically every intervalMs while
 * `pre-init state` (no framework document yet) reports phase pending-init.
 * Real phase transitions (reconciling/live/...) land with the reconciler (T3.x).
 */
export function startHeartbeat(
  statusDir: string,
  state: HeartbeatState,
  intervalMs = 10_000,
): { stop: () => void } {
  const filePath = `${statusDir}/framework.json`;

  async function tick(): Promise<void> {
    state.current = { ...state.current, ts: new Date().toISOString() };
    await atomicWriteFile(filePath, JSON.stringify(state.current), { mode: 0o644 });
  }

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
