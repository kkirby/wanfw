import type { NamedStage, ReconcileRunContext, StageResult } from "./types.js";
import type { PlanGraph, PluginInvoker } from "./plan-stage.js";
import { WILDCARD_CERT_NAME } from "./plan-stage.js";
import type { FrameworkRolesHolder } from "./core-stages.js";
import { computeRenewalDecision, isEscalated, type RenewalState } from "../renewal/scheduler.js";

export interface RenewalStageDeps {
  invokePlugin: PluginInvoker;
  rolesHolder: FrameworkRolesHolder;
  readRenewalState: (certName: string) => RenewalState;
  writeRenewalState: (certName: string, state: RenewalState) => void;
  /** meta.storedAt / meta.names of the cert's current generation, or undefined if it's never been stored (T4.5's `listCerts`/`currentCertPaths` shape). */
  readCertMeta: (certName: string) => { storedAt: string; names: string[] } | undefined;
  onCertChange?: () => void;
  now?: () => Date;
}

/**
 * RENEWAL stage (§9, T4.6): runs after PLAN so it has `certRequirements.names`
 * (the desired SAN set from every service's `expose.hostname`) available.
 * Non-fatal by design -- a renewal problem never fails the reconcile
 * pipeline or blocks unrelated services from deploying; it only ever
 * flags `ctx.degraded` for the engine to surface as a `degraded` phase
 * (§9's "framework-wide degraded" escalation) once the currently *served*
 * cert has fewer than `ESCALATE_WITHIN_DAYS` left, independent of whether
 * a renewal attempt is currently in flight or backing off.
 *
 * One cert per framework, named `WILDCARD_CERT_NAME` (T4.5's convention:
 * cert-letsencrypt-dns01 issues a single SAN cert covering every exposed
 * hostname) -- bound to whichever plugin currently holds the `certIssuer`
 * role, the same role-binding pattern T4.3 already established for
 * `dnsProvider`. No `certIssuer` binding and no names required is a no-op;
 * names required with no binding is itself a degraded condition (exposure
 * is configured but nothing can ever issue a cert for it).
 */
export function buildRenewalStage(deps: RenewalStageDeps): NamedStage {
  const now = deps.now ?? (() => new Date());
  return {
    name: "renewal",
    run: async (ctx: ReconcileRunContext): Promise<StageResult> => {
      const graph = ctx.planGraph as PlanGraph | undefined;
      const names = graph?.certRequirements.names ?? [];
      if (names.length === 0) {
        return { ok: true }; // nothing exposed yet -- nothing to certify
      }

      const certIssuerId = deps.rolesHolder.roles.certIssuer;
      const meta = deps.readCertMeta(WILDCARD_CERT_NAME);
      const namesMatch = meta !== undefined && [...meta.names].sort().join(",") === [...names].sort().join(",");
      // Read before the escalation check below (not after, as this used to
      // be ordered) so a real prior-failure reason is available to fold
      // into degradedReason instead of only ever a generic message.
      const state = deps.readRenewalState(WILDCARD_CERT_NAME);

      if (isEscalated(now(), meta?.storedAt, true)) {
        ctx.degraded = true;
        ctx.degradedReason = {
          stage: "renewal",
          message: meta
            ? `cert '${WILDCARD_CERT_NAME}' has fewer than 7 days remaining and has not been renewed in time` +
              (state.lastError ? `; last renewal attempt failed: ${state.lastError.message}` : "")
            : `no cert has ever been issued for required names [${names.join(", ")}]` +
              (state.lastError ? `; last attempt failed: ${state.lastError.message}` : ""),
        };
      }

      if (!certIssuerId) {
        // Exposure is configured but there's no cert-issuer bound at all --
        // already reflected in the escalation check above when a cert is
        // genuinely missing; if a cert exists and is not yet near
        // expiry, this is silently a no-op (framework may intentionally
        // run cert-less over plain internal-CA TLS in earlier milestones).
        return { ok: true };
      }

      const decision = computeRenewalDecision({
        now: now(),
        certName: WILDCARD_CERT_NAME,
        storedAt: meta?.storedAt,
        namesMatch,
        state,
      });

      if (!decision.due) {
        return { ok: true };
      }

      const result = await deps.invokePlugin(certIssuerId, "cert.ensure", { certName: WILDCARD_CERT_NAME, names });
      const attemptedAt = now().toISOString();
      if (result.ok) {
        deps.writeRenewalState(WILDCARD_CERT_NAME, { lastAttemptAt: attemptedAt, lastSuccessAt: attemptedAt, consecutiveFailures: 0 });
        deps.onCertChange?.();
      } else {
        deps.writeRenewalState(WILDCARD_CERT_NAME, {
          ...state,
          lastAttemptAt: attemptedAt,
          consecutiveFailures: state.consecutiveFailures + 1,
          lastError: result.error,
        });
        // A failed renewal attempt is itself non-fatal to the reconcile --
        // the escalation check above already promoted this to `degraded`
        // once it's within 7 days (now with the real failure reason folded
        // in, via the `state.lastError` read at the top of this stage);
        // before that, it's just a retry that'll be attempted again per the
        // backoff schedule.
      }

      return { ok: true };
    },
  };
}
