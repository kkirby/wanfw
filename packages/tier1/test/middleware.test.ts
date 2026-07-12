import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// middleware.ts transitively imports lib/session-db.ts, which opens a
// sqlite connection (mkdir + touch a file) at module load time -- same
// env-var-before-import requirement session-db.test.ts already documents.
process.env.WANFW_TIER1STATE_DB = join(mkdtempSync(join(tmpdir(), "wanfw-tier1-mw-")), "tier1.sqlite3");

const { cspHeader } = await import("../middleware.js");

describe("cspHeader (T6.4, §10.3 interpretation 5)", () => {
  it("is nonce-based and strict-dynamic on scripts, never a blanket unsafe-inline", () => {
    const csp = cspHeader("abc123");
    expect(csp).toContain("script-src 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });

  it("keeps style-src-elem nonce-strict, with unsafe-inline confined to style-src-attr only (the documented Mantine concession)", () => {
    const csp = cspHeader("abc123");
    expect(csp).toContain("style-src-elem 'self' 'nonce-abc123'");
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).not.toMatch(/style-src-elem[^;]*unsafe-inline/);
  });

  it("blocks framing, plugins, and dangling base tags", () => {
    const csp = cspHeader("abc123");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("produces a distinct nonce string per call at the call site (not memoized/reused)", () => {
    const a = cspHeader("nonce-a");
    const b = cspHeader("nonce-b");
    expect(a).not.toBe(b);
  });
});
