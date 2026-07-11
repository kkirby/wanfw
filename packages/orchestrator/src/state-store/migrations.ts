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
