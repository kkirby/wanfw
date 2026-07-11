// Dev bootstrap (T1.4): writes an admin password hash directly into
// wanfw_tier1state. wanfwctl init (T5.3) replaces this with the real
// first-run flow; this script exists only so T1.4 can be tested end to end
// before the wizard lands.
import { hash } from "@node-rs/argon2";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const password = process.argv[2] ?? process.env.WANFW_SEED_ADMIN_PASSWORD;
if (!password) {
  console.error("usage: seed-admin.mjs <password>  (or set WANFW_SEED_ADMIN_PASSWORD)");
  process.exit(2);
}

const dbPath = process.env.WANFW_TIER1STATE_DB ?? "/data/state/tier1.sqlite3";
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_user (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const passwordHash = await hash(password, { algorithm: 2 });
db.prepare(
  `INSERT INTO admin_user (id, password_hash, created_at) VALUES (1, ?, ?)
   ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash`,
).run(passwordHash, new Date().toISOString());

console.log(`admin password hash written to ${dbPath}`);
