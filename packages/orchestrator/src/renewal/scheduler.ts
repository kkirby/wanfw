/**
 * Renewal decision logic (§9, T4.6): pure and clock-injected so every
 * timing edge (backoff steps, the 30-day renewal window, the 7-day
 * escalation threshold) is unit-testable without real wall-clock waits.
 *
 * Let's Encrypt certs are always 90 days (RFC 8555 doesn't expose a
 * negotiable lifetime, and Let's Encrypt has never issued anything else in
 * production); rather than parsing the issued cert's own X.509 notAfter
 * (a full DER parser this codebase doesn't otherwise need), remaining
 * lifetime is derived from the stored generation's `storedAt` timestamp
 * plus this fixed constant. If a future cert-issuer plugin ever supports a
 * different CA with a different lifetime, this constant is the one place
 * that assumption lives.
 */
export const CERT_LIFETIME_DAYS = 90;
export const RENEW_WITHIN_DAYS = 30;
export const ESCALATE_WITHIN_DAYS = 7;

/** Escalating retry backoff after a failed renewal attempt: 1h, 4h, 12h, then daily forever. */
const BACKOFF_STEPS_MS = [1, 4, 12, 24].map((h) => h * 3600_000);

/** Routine (non-failing, cert not yet in its renewal window) re-checks are paced to about once a day, jittered per cert name so many wanfw instances don't all hit the ACME server at the same moment. */
const DAILY_MS = 24 * 3600_000;
const JITTER_SPREAD_MS = 4 * 3600_000;

export interface RenewalState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
  /** The real error from the most recent failed renewal attempt, so an operator can see *why* it's retrying, not just that it is. Structurally mirrors certs/store.ts's own RenewalState (the two aren't unified into one shared type, so keep them in sync). */
  lastError?: { code: string; message: string };
}

export const INITIAL_RENEWAL_STATE: RenewalState = { consecutiveFailures: 0 };

export interface RenewalDecisionInput {
  now: Date;
  certName: string;
  /** `meta.storedAt` of the currently active generation, or undefined if this cert has never been stored. */
  storedAt?: string;
  /** Whether the currently stored generation's SAN set matches what's currently desired (from PLAN's certRequirements.names). */
  namesMatch: boolean;
  state: RenewalState;
}

export interface RenewalDecision {
  due: boolean;
  reason: "uncovered" | "san-mismatch" | "renewal-window" | "not-yet-due" | "backoff";
}

function jitterMs(certName: string): number {
  let hash = 0;
  for (let i = 0; i < certName.length; i++) hash = (hash * 31 + certName.charCodeAt(i)) >>> 0;
  return hash % JITTER_SPREAD_MS;
}

function dueByBackoffOrPace(now: Date, state: RenewalState, paceMs: number): boolean {
  if (!state.lastAttemptAt) return true;
  const elapsed = now.getTime() - new Date(state.lastAttemptAt).getTime();
  if (state.consecutiveFailures > 0) {
    const step = BACKOFF_STEPS_MS[Math.min(state.consecutiveFailures - 1, BACKOFF_STEPS_MS.length - 1)]!;
    return elapsed >= step;
  }
  return elapsed >= paceMs;
}

/** Remaining days on the currently stored generation, or undefined if none has ever been stored. */
export function remainingDays(now: Date, storedAt: string | undefined): number | undefined {
  if (!storedAt) return undefined;
  const ageMs = now.getTime() - new Date(storedAt).getTime();
  return CERT_LIFETIME_DAYS - ageMs / 86_400_000;
}

/**
 * Decides whether a renewal attempt (a real `cert.ensure` invocation) is
 * due right now. A never-stored or SAN-mismatched cert is "on-demand" --
 * checked (subject only to failure backoff, not the daily pace) on every
 * call -- while a cert that's already covering the right names and not yet
 * within its renewal window is paced to roughly once a day, jittered per
 * name.
 */
export function computeRenewalDecision(input: RenewalDecisionInput): RenewalDecision {
  const { now, certName, storedAt, namesMatch, state } = input;

  if (!storedAt || !namesMatch) {
    if (!dueByBackoffOrPace(now, state, 0)) return { due: false, reason: "backoff" };
    return { due: true, reason: storedAt ? "san-mismatch" : "uncovered" };
  }

  const remaining = remainingDays(now, storedAt)!;
  if (remaining > RENEW_WITHIN_DAYS) {
    return { due: false, reason: "not-yet-due" };
  }

  // Within the renewal window: pace repeated attempts to roughly once a day
  // (jittered per cert name) once there's no active failure backoff, so a
  // reconcile firing every 60s doesn't hammer the ACME server every tick.
  const paceMs = DAILY_MS + jitterMs(certName);
  if (!dueByBackoffOrPace(now, state, paceMs)) return { due: false, reason: "backoff" };
  return { due: true, reason: "renewal-window" };
}

/** True once the currently *served* cert (regardless of whether a renewal is in flight or backing off) has fewer than ESCALATE_WITHIN_DAYS left -- or never existed at all while names are required. */
export function isEscalated(now: Date, storedAt: string | undefined, namesRequired: boolean): boolean {
  if (!namesRequired) return false;
  if (!storedAt) return true; // exposure is configured but nothing has ever been issued
  return remainingDays(now, storedAt)! < ESCALATE_WITHIN_DAYS;
}
