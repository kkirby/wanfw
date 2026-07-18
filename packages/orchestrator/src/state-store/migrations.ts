import type Database from "better-sqlite3";

export interface Migration {
  id: number;
  sql: string;
}

/**
 * Table shapes per plan T2.1. Applied in order inside one transaction;
 * `schema_migrations` tracks what has already run so this is safe to call
 * on every boot.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS trust_records (
        plugin_id TEXT NOT NULL,
        version TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        granted_caps_json TEXT NOT NULL,
        sig TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (plugin_id, version)
      );

      CREATE TABLE IF NOT EXISTS grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        cap TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        sig TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        projection_hash TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        human_rendering TEXT NOT NULL,
        sig TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ipam_ranges (
        id TEXT PRIMARY KEY,
        cidr TEXT NOT NULL,
        gateway TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ipam_allocations (
        ip TEXT PRIMARY KEY,
        range_id TEXT NOT NULL,
        allocated_at TEXT NOT NULL,
        released_at TEXT
      );

      CREATE TABLE IF NOT EXISTS plugin_kv (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (plugin_id, key)
      );

      CREATE TABLE IF NOT EXISTS journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL,
        step TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result TEXT NOT NULL,
        ts TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    // Fixes a real leak: `network-macvlan`'s plan-time `ipam.allocate`
    // call had no idempotency key, so every single reconcile (the 60s
    // timer alone, never mind a crash-loop restarting on every boot)
    // permanently allocated a *new* address for the same static proxy IP
    // and never released the previous one -- silently exhausting the
    // reserved range over time, at which point PLAN starts failing outright
    // (blocking every stage downstream of it, including cert renewal).
    // `owner` lets `allocateIp` reuse the same address for the same
    // logical resource (keyed by `EndpointRequest.purpose`) instead of
    // minting a fresh one every time. Every row that predates this column
    // is, by construction, one of these orphaned leaks (nothing before
    // this migration could have set an owner) -- soft-released here so a
    // range that's already exhausted self-heals on the next boot instead
    // of requiring an operator to hand-edit the sqlite file.
    sql: `
      ALTER TABLE ipam_allocations ADD COLUMN owner TEXT;
      UPDATE ipam_allocations SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE released_at IS NULL AND owner IS NULL;
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: number }>).map((r) => r.id),
  );

  const applyOne = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migration.id,
      new Date().toISOString(),
    );
  });

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.id)) {
      applyOne(migration);
    }
  }
}
