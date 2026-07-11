"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "../../lib/auth";
import { deleteSession } from "../../lib/session-db";

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE_NAME)?.value;
  if (sessionId) {
    deleteSession(sessionId);
  }
  store.delete(SESSION_COOKIE_NAME);
  redirect("/login");
}
