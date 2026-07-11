import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("session-db", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wanfw-tier1-db-"));
    process.env.WANFW_TIER1STATE_DB = join(dir, "tier1.sqlite3");
    // The module opens its DB connection at import time using the env var
    // above; force re-evaluation so each test gets its own fresh database.
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.WANFW_TIER1STATE_DB;
  });

  async function freshDb() {
    const mod = await import("../lib/session-db.js");
    return mod;
  }

  it("hasAdminUser is false until setAdminPasswordHash is called", async () => {
    const { hasAdminUser, setAdminPasswordHash } = await freshDb();
    expect(hasAdminUser()).toBe(false);
    setAdminPasswordHash("some-hash");
    expect(hasAdminUser()).toBe(true);
  });

  it("getAdminPasswordHash returns exactly what was set", async () => {
    const { setAdminPasswordHash, getAdminPasswordHash } = await freshDb();
    setAdminPasswordHash("hash-abc");
    expect(getAdminPasswordHash()).toBe("hash-abc");
  });

  it("createSession produces a valid session that isSessionValid confirms", async () => {
    const { createSession, isSessionValid } = await freshDb();
    const session = createSession();
    expect(isSessionValid(session.id)).toBe(true);
    expect(isSessionValid("not-a-real-session-id")).toBe(false);
  });

  it("deleteSession invalidates the session", async () => {
    const { createSession, isSessionValid, deleteSession } = await freshDb();
    const session = createSession();
    deleteSession(session.id);
    expect(isSessionValid(session.id)).toBe(false);
  });

  it("checkAndRecordLoginAttempt allows the first N attempts then blocks", async () => {
    const { checkAndRecordLoginAttempt } = await freshDb();
    const ip = "10.0.0.5";
    const results: boolean[] = [];
    for (let i = 0; i < 12; i++) {
      results.push(checkAndRecordLoginAttempt(ip).allowed);
    }
    expect(results.slice(0, 10)).toEqual(Array(10).fill(true));
    expect(results.slice(10)).toEqual([false, false]);
  });

  it("checkAndRecordLoginAttempt tracks IPs independently", async () => {
    const { checkAndRecordLoginAttempt } = await freshDb();
    for (let i = 0; i < 10; i++) checkAndRecordLoginAttempt("1.1.1.1");
    expect(checkAndRecordLoginAttempt("1.1.1.1").allowed).toBe(false);
    expect(checkAndRecordLoginAttempt("2.2.2.2").allowed).toBe(true);
  });

  it("resetLoginAttempts clears the counter for that IP", async () => {
    const { checkAndRecordLoginAttempt, resetLoginAttempts } = await freshDb();
    const ip = "3.3.3.3";
    for (let i = 0; i < 10; i++) checkAndRecordLoginAttempt(ip);
    expect(checkAndRecordLoginAttempt(ip).allowed).toBe(false);
    resetLoginAttempts(ip);
    expect(checkAndRecordLoginAttempt(ip).allowed).toBe(true);
  });
});
