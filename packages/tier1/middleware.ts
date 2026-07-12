import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "./lib/auth";
import { isSessionValid } from "./lib/session-db";

export function middleware(req: NextRequest) {
  const sessionId = req.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!sessionId || !isSessionValid(sessionId)) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|setup|_next/static|_next/image|favicon.ico).*)"],
  runtime: "nodejs",
};
