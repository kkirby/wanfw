/**
 * Stable, documented wanfwctl exit codes (spec §11, plan interpretation 7).
 * Any command that exits must map its outcome to exactly one of these.
 */
export const EXIT_CODES = {
  ok: 0,
  internalError: 1,
  usage: 2,
  pendingApprovalExists: 3,
  validationFailure: 4,
  notFound: 5,
  refused: 6,
  daemonUnreachable: 7,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];

export const EXIT_CODE_DESCRIPTIONS: Record<ExitCodeName, string> = {
  ok: "command completed successfully",
  internalError: "unexpected internal error",
  usage: "invalid invocation (bad flags/arguments)",
  pendingApprovalExists: "a matching pending approval already exists",
  validationFailure: "document or input failed validation",
  notFound: "the requested object does not exist",
  refused: "refused: trust/hash mismatch or capability violation",
  daemonUnreachable: "could not reach the orchestrator admin socket",
};
