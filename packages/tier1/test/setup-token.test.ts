import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("setup-token (T5.3, docs/t5.3-decisions.md Decision 2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wanfw-tier1-status-"));
    process.env.WANFW_STATUS_DIR = dir;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.WANFW_STATUS_DIR;
  });

  async function freshMod() {
    return import("../lib/setup-token.js");
  }

  it("returns false when no token file exists at all", async () => {
    const { verifySetupToken } = await freshMod();
    expect(await verifySetupToken("anything")).toBe(false);
  });

  it("returns true for a matching, fresh token", async () => {
    writeFileSync(join(dir, "setup-token.json"), JSON.stringify({ token: "abc123", createdAt: new Date().toISOString() }));
    const { verifySetupToken } = await freshMod();
    expect(await verifySetupToken("abc123")).toBe(true);
  });

  it("returns false for a non-matching token", async () => {
    writeFileSync(join(dir, "setup-token.json"), JSON.stringify({ token: "abc123", createdAt: new Date().toISOString() }));
    const { verifySetupToken } = await freshMod();
    expect(await verifySetupToken("wrong-token")).toBe(false);
  });

  it("returns false for a token older than 24h", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(dir, "setup-token.json"), JSON.stringify({ token: "abc123", createdAt: old }));
    const { verifySetupToken } = await freshMod();
    expect(await verifySetupToken("abc123")).toBe(false);
  });

  it("returns false for malformed JSON", async () => {
    writeFileSync(join(dir, "setup-token.json"), "not json");
    const { verifySetupToken } = await freshMod();
    expect(await verifySetupToken("abc123")).toBe(false);
  });
});
