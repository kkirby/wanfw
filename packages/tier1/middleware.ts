import { createHash, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "./lib/auth";
import { isSessionValid } from "./lib/session-db";
import { log } from "./lib/logger";

const UNAUTHENTICATED_PATHS = new Set(["/login", "/setup"]);

/**
 * T6.4 (§10.3, interpretation 5): strict, nonce-based CSP applied to every
 * response -- Next.js auto-applies a nonce it finds on the request's own
 * `Content-Security-Policy` header to every `<script>`/`<style>` tag it
 * injects itself, so setting it here (not just on the response) is what
 * makes framework-injected tags carry the nonce too. `style-src-attr
 * 'unsafe-inline'` is the one documented concession (Mantine sets CSS
 * custom properties via element `style=` attributes, not `<style>` tags;
 * `style-src-elem` stays nonce-strict) -- see docs/threat-model.md.
 */
export function cspHeader(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function applySecurityHeaders(res: NextResponse, nonce: string): NextResponse {
  res.headers.set("Content-Security-Policy", cspHeader(nonce));
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

export function middleware(req: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("Content-Security-Policy", cspHeader(nonce)); // read back via headers() in the root layout to nonce our own <script> tags
  requestHeaders.set("x-nonce", nonce);

  const sessionId = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  // Structured request log (§10.3): session id is hashed, never logged in
  // the clear -- it is a live bearer credential, same standard the audit
  // log and secrets store already hold elsewhere in this codebase.
  const sessionIdHash = sessionId ? createHash("sha256").update(sessionId).digest("hex").slice(0, 16) : null;
  const start = Date.now();
  log.info("request", {
    method: req.method,
    path: req.nextUrl.pathname,
    sessionIdHash,
    // Next.js middleware runs before the route handler and never observes
    // its eventual status/duration in the supported App Router model (no
    // custom server here, deliberately -- T6.3's read-only/standalone
    // deployment shape) -- logged as a request-received event, not a
    // request-completed one; see docs/threat-model.md for this deviation.
    durationMs: Date.now() - start,
  });

  const pathname = req.nextUrl.pathname;
  if (!UNAUTHENTICATED_PATHS.has(pathname) && (!sessionId || !isSessionValid(sessionId))) {
    const loginUrl = new URL("/login", req.url);
    return applySecurityHeaders(NextResponse.redirect(loginUrl), nonce);
  }

  return applySecurityHeaders(NextResponse.next({ request: { headers: requestHeaders } }), nonce);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
  runtime: "nodejs",
};
