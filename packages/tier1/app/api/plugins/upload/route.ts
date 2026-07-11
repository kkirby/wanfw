import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "../../../../lib/auth";
import { isSessionValid } from "../../../../lib/session-db";
import { streamUploadToStaging, UploadTooLargeError, InvalidBundleError } from "../../../../lib/plugin-upload";

const STAGING_DIR = process.env.WANFW_STAGING_DIR ?? "/data/staging";

/**
 * Streaming upload (spec §10.3, T2.10): route handler (not a server action,
 * which can't stream a request body), session-cookie protected same as
 * every other authenticated route (middleware.ts guards everything except
 * /login); CSRF covered by the same-origin fetch from the plugins page's
 * own upload form plus Next's built-in Origin/Host enforcement on non-GET
 * requests. Actual streaming/hashing/extraction logic lives in
 * lib/plugin-upload.ts so it's unit-testable without a Next.js request
 * context (cookies() only works inside one).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionId || !isSessionValid(sessionId)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!req.body) {
    return NextResponse.json({ error: "usage", message: "empty request body" }, { status: 400 });
  }

  try {
    const result = await streamUploadToStaging(req.body, STAGING_DIR);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return NextResponse.json({ error: "too_large", message: err.message }, { status: 413 });
    }
    if (err instanceof InvalidBundleError) {
      return NextResponse.json({ error: "invalid_bundle", message: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "upload_failed", message: (err as Error).message }, { status: 500 });
  }
}
