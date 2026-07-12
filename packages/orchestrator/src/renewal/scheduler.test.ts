import { describe, expect, it } from "vitest";
import { computeRenewalDecision, isEscalated, remainingDays, type RenewalState } from "./scheduler.js";

const FRESH: RenewalState = { consecutiveFailures: 0 };

describe("renewal scheduler (§9, T4.6)", () => {
  it("a never-stored cert is due immediately (uncovered), on-demand", () => {
    const decision = computeRenewalDecision({
      now: new Date("2026-07-12T00:00:00Z"),
      certName: "wildcard",
      storedAt: undefined,
      namesMatch: false,
      state: FRESH,
    });
    expect(decision).toEqual({ due: true, reason: "uncovered" });
  });

  it("a stored cert whose SAN set no longer matches the desired names is due immediately (san-mismatch)", () => {
    const decision = computeRenewalDecision({
      now: new Date("2026-07-12T00:00:00Z"),
      certName: "wildcard",
      storedAt: "2026-07-01T00:00:00Z",
      namesMatch: false,
      state: FRESH,
    });
    expect(decision).toEqual({ due: true, reason: "san-mismatch" });
  });

  it("a fresh cert well within its 90-day lifetime is not yet due", () => {
    const decision = computeRenewalDecision({
      now: new Date("2026-07-12T00:00:00Z"),
      certName: "wildcard",
      storedAt: "2026-07-01T00:00:00Z", // 11 days old, 79 remaining
      namesMatch: true,
      state: FRESH,
    });
    expect(decision).toEqual({ due: false, reason: "not-yet-due" });
  });

  it("a cert within 30 days of expiry is due for renewal", () => {
    const decision = computeRenewalDecision({
      now: new Date("2026-07-12T00:00:00Z"),
      certName: "wildcard",
      storedAt: "2026-04-20T00:00:00Z", // 83 days old, 7 remaining
      namesMatch: true,
      state: FRESH,
    });
    expect(decision).toEqual({ due: true, reason: "renewal-window" });
  });

  it("respects failure backoff -- a recent failed attempt is not retried within its backoff step", () => {
    const state: RenewalState = { consecutiveFailures: 1, lastAttemptAt: "2026-07-12T00:00:00Z" };
    const decision = computeRenewalDecision({
      now: new Date("2026-07-12T00:30:00Z"), // 30 min later, backoff step 1 is 1h
      certName: "wildcard",
      storedAt: undefined,
      namesMatch: false,
      state,
    });
    expect(decision).toEqual({ due: false, reason: "backoff" });
  });

  it("retries once the backoff step has elapsed", () => {
    const state: RenewalState = { consecutiveFailures: 1, lastAttemptAt: "2026-07-12T00:00:00Z" };
    const decision = computeRenewalDecision({
      now: new Date("2026-07-12T01:00:01Z"), // just past the 1h step-1 backoff
      certName: "wildcard",
      storedAt: undefined,
      namesMatch: false,
      state,
    });
    expect(decision).toEqual({ due: true, reason: "uncovered" });
  });

  it("backoff escalates through 1h/4h/12h and caps at daily for further failures", () => {
    const now = new Date("2026-07-12T00:00:00Z");
    const attemptedJustNow = (failures: number) => ({ consecutiveFailures: failures, lastAttemptAt: now.toISOString() });

    // 3h after a 2nd consecutive failure (step index 1 -> 4h): still backing off.
    expect(
      computeRenewalDecision({
        now: new Date(now.getTime() + 3 * 3600_000),
        certName: "wildcard",
        storedAt: undefined,
        namesMatch: false,
        state: attemptedJustNow(2),
      }).due,
    ).toBe(false);

    // 25h after a 10th consecutive failure (capped at the daily step): due again.
    expect(
      computeRenewalDecision({
        now: new Date(now.getTime() + 25 * 3600_000),
        certName: "wildcard",
        storedAt: undefined,
        namesMatch: false,
        state: attemptedJustNow(10),
      }).due,
    ).toBe(true);
  });

  it("within the renewal window but not yet failing, repeated checks are paced rather than firing every call", () => {
    const state: RenewalState = { consecutiveFailures: 0, lastAttemptAt: "2026-07-12T00:00:00Z", lastSuccessAt: undefined };
    const decision = computeRenewalDecision({
      now: new Date("2026-07-12T02:00:00Z"), // 2h after a no-failure attempt, well under the ~daily pace
      certName: "wildcard",
      storedAt: "2026-04-20T00:00:00Z",
      namesMatch: true,
      state,
    });
    expect(decision).toEqual({ due: false, reason: "backoff" });
  });

  it("remainingDays computes 90 minus the cert's age, undefined when never stored", () => {
    expect(remainingDays(new Date("2026-07-12T00:00:00Z"), undefined)).toBeUndefined();
    expect(remainingDays(new Date("2026-07-12T00:00:00Z"), "2026-07-02T00:00:00Z")).toBe(80);
  });

  describe("isEscalated", () => {
    it("is false when no names are required at all", () => {
      expect(isEscalated(new Date("2026-07-12T00:00:00Z"), undefined, false)).toBe(false);
    });

    it("is true when names are required but nothing has ever been stored", () => {
      expect(isEscalated(new Date("2026-07-12T00:00:00Z"), undefined, true)).toBe(true);
    });

    it("is true once the currently served cert has fewer than 7 days left", () => {
      expect(isEscalated(new Date("2026-07-12T00:00:00Z"), "2026-04-16T00:00:00Z", true)).toBe(true); // 87 days old, 3 remaining
    });

    it("is false while the currently served cert still has 7+ days left", () => {
      expect(isEscalated(new Date("2026-07-12T00:00:00Z"), "2026-04-20T00:00:00Z", true)).toBe(false); // 83 days old, 7 remaining
    });
  });
});
