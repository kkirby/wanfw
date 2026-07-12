"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME, hashPassword } from "../../lib/auth";
import { createSession, hasAdminUser, setAdminPasswordHash } from "../../lib/session-db";
import { verifySetupToken } from "../../lib/setup-token";

export interface SetupActionState {
  error?: string;
}

/**
 * First-run admin account creation (T5.3/T5.5, docs/t5.3-decisions.md
 * Decision 2). Gated by two independent checks: no admin account exists
 * yet (once one does, this action -- and the page -- are permanently
 * dead, regardless of token), and the submitted token matches the
 * wizard-issued one-time token in wanfw_status within its 24h window.
 * The password itself never leaves this action: no plaintext or hash
 * transits the orchestrator, a shared volume, or the CLI.
 */
export async function setupAction(_prevState: SetupActionState, formData: FormData): Promise<SetupActionState> {
  if (hasAdminUser()) {
    return { error: "An admin account already exists. Log in instead." };
  }

  const token = String(formData.get("token") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (!(await verifySetupToken(token))) {
    return { error: "Invalid or expired setup token. Run `wanfwctl init` on the host to get a new one." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirm) {
    return { error: "Passwords do not match." };
  }

  const passwordHash = await hashPassword(password);
  setAdminPasswordHash(passwordHash);

  const session = createSession();
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    expires: new Date(session.expiresAt),
  });

  redirect("/");
}
