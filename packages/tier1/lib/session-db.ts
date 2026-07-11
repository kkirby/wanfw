import "server-only";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.WANFW_TIER1STATE_DB ?? "/data/state/tier1.sqlite3";

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_user (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_started_at TEXT NOT NULL
  );
`);

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5m
const RATE_LIMIT_MAX_ATTEMPTS = 10;

export function hasAdminUser(): boolean {
  return db.prepare("SELECT 1 FROM admin_user WHERE id = 1").get() !== undefined;
}

export function setAdminPasswordHash(hash: string): void {
  db.prepare(
    `INSERT INTO admin_user (id, password_hash, created_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash`,
  ).run(hash, new Date().toISOString());
}

export function getAdminPasswordHash(): string | undefined {
  const row = db.prepare("SELECT password_hash FROM admin_user WHERE id = 1").get() as
    | { password_hash: string }
    | undefined;
  return row?.password_hash;
}

export function createSession(): { id: string; expiresAt: string } {
  const id = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.prepare("INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)").run(
    id,
    now.toISOString(),
    expiresAt,
  );
  return { id, expiresAt };
}

export function isSessionValid(sessionId: string): boolean {
  const row = db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(sessionId) as
    | { expires_at: string }
    | undefined;
  if (!row) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

export function deleteSession(sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

/** Sliding-window login rate limit, persisted so it survives process restarts. */
export function checkAndRecordLoginAttempt(ip: string): { allowed: boolean } {
  const now = Date.now();
  const row = db.prepare("SELECT count, window_started_at FROM login_attempts WHERE ip = ?").get(ip) as
    | { count: number; window_started_at: string }
    | undefined;

  if (!row || now - new Date(row.window_started_at).getTime() > RATE_LIMIT_WINDOW_MS) {
    db.prepare(
      `INSERT INTO login_attempts (ip, count, window_started_at) VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET count = 1, window_started_at = excluded.window_started_at`,
    ).run(ip, new Date(now).toISOString());
    return { allowed: true };
  }

  if (row.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return { allowed: false };
  }

  db.prepare("UPDATE login_attempts SET count = count + 1 WHERE ip = ?").run(ip);
  return { allowed: true };
}

export function resetLoginAttempts(ip: string): void {
  db.prepare("DELETE FROM login_attempts WHERE ip = ?").run(ip);
}
