"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME, verifyPassword } from "../../lib/auth";
import {
  checkAndRecordLoginAttempt,
  createSession,
  getAdminPasswordHash,
  hasAdminUser,
  resetLoginAttempts,
} from "../../lib/session-db";

export interface LoginActionState {
  error?: string;
}

export async function loginAction(_prevState: LoginActionState, formData: FormData): Promise<LoginActionState> {
  const password = String(formData.get("password") ?? "");
  const headerList = await headers();
  // x-forwarded-for is only trustworthy behind a controlled reverse proxy;
  // v1 has no such proxy in front of tier1 (ADR-7: LAN/VPN-only), so the
  // remote address as seen by Next.js is what we rate-limit on.
  const ip = headerList.get("x-forwarded-for") ?? "unknown";

  const { allowed } = checkAndRecordLoginAttempt(ip);
  if (!allowed) {
    return { error: "Too many attempts. Try again in a few minutes." };
  }

  if (!hasAdminUser()) {
    return { error: "No admin account is configured yet." };
  }

  const passwordHash = getAdminPasswordHash();
  const valid = passwordHash ? await verifyPassword(passwordHash, password) : false;
  if (!valid) {
    return { error: "Incorrect password." };
  }

  resetLoginAttempts(ip);
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
