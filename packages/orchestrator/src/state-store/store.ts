import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./migrations.js";

export interface TrustRecordRow {
  plugin_id: string;
  version: string;
  sha256: string;
  granted_caps_json: string;
  sig: string;
  created_at: string;
  revoked_at: string | null;
}

export interface GrantRow {
  id: number;
  plugin_id: string;
  cap: string;
  scope_json: string;
  sig: string;
  created_at: string;
  revoked_at: string | null;
}

export interface ApprovalRow {
  projection_hash: string;
  service_id: string;
  human_rendering: string;
  sig: string;
  approved_at: string;
  revoked_at: string | null;
}

export interface JournalRow {
  id: number;
  plan_id: string;
  step: string;
  payload_json: string;
  result: string;
  ts: string;
}

export class StateStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    runMigrations(this.db);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // best-effort; some filesystems in dev/test environments reject chmod
    }
  }

  close(): void {
    this.db.close();
  }

  // -- meta --------------------------------------------------------------
  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // -- trust_records -------------------------------------------------------
  insertTrustRecord(row: Omit<TrustRecordRow, "revoked_at">): void {
    this.db
      .prepare(
        `INSERT INTO trust_records (plugin_id, version, sha256, granted_caps_json, sig, created_at)
         VALUES (@plugin_id, @version, @sha256, @granted_caps_json, @sig, @created_at)`,
      )
      .run(row);
  }

  getTrustRecord(pluginId: string, version: string): TrustRecordRow | undefined {
    return this.db
      .prepare("SELECT * FROM trust_records WHERE plugin_id = ? AND version = ?")
      .get(pluginId, version) as TrustRecordRow | undefined;
  }

  listTrustRecords(includeRevoked = false): TrustRecordRow[] {
    const sql = includeRevoked
      ? "SELECT * FROM trust_records ORDER BY plugin_id, version"
      : "SELECT * FROM trust_records WHERE revoked_at IS NULL ORDER BY plugin_id, version";
    return this.db.prepare(sql).all() as TrustRecordRow[];
  }

  revokeTrustRecord(pluginId: string, version: string): void {
    this.db
      .prepare("UPDATE trust_records SET revoked_at = ? WHERE plugin_id = ? AND version = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), pluginId, version);
  }

  // -- grants --------------------------------------------------------------
  insertGrant(row: Omit<GrantRow, "id" | "revoked_at">): number {
    const result = this.db
      .prepare(
        `INSERT INTO grants (plugin_id, cap, scope_json, sig, created_at)
         VALUES (@plugin_id, @cap, @scope_json, @sig, @created_at)`,
      )
      .run(row);
    return Number(result.lastInsertRowid);
  }

  listGrants(pluginId: string, includeRevoked = false): GrantRow[] {
    const sql = includeRevoked
      ? "SELECT * FROM grants WHERE plugin_id = ? ORDER BY id"
      : "SELECT * FROM grants WHERE plugin_id = ? AND revoked_at IS NULL ORDER BY id";
    return this.db.prepare(sql).all(pluginId) as GrantRow[];
  }

  revokeGrant(id: number): void {
    this.db.prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
      new Date().toISOString(),
      id,
    );
  }

  // -- approvals -------------------------------------------------------------
  insertApproval(row: Omit<ApprovalRow, "revoked_at">): void {
    this.db
      .prepare(
        `INSERT INTO approvals (projection_hash, service_id, human_rendering, sig, approved_at)
         VALUES (@projection_hash, @service_id, @human_rendering, @sig, @approved_at)
         ON CONFLICT(projection_hash) DO UPDATE SET
           service_id = excluded.service_id,
           human_rendering = excluded.human_rendering,
           sig = excluded.sig,
           approved_at = excluded.approved_at,
           revoked_at = NULL`,
      )
      .run(row);
  }

  getApproval(projectionHash: string): ApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE projection_hash = ?").get(projectionHash) as
      | ApprovalRow
      | undefined;
  }

  isApproved(projectionHash: string): boolean {
    const row = this.getApproval(projectionHash);
    return row !== undefined && row.revoked_at === null;
  }

  listApprovals(includeRevoked = false): ApprovalRow[] {
    const sql = includeRevoked
      ? "SELECT * FROM approvals ORDER BY approved_at"
      : "SELECT * FROM approvals WHERE revoked_at IS NULL ORDER BY approved_at";
    return this.db.prepare(sql).all() as ApprovalRow[];
  }

  revokeApproval(projectionHash: string): void {
    this.db
      .prepare("UPDATE approvals SET revoked_at = ? WHERE projection_hash = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), projectionHash);
  }

  // -- plugin_kv -------------------------------------------------------------
  getPluginKv(pluginId: string, key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?")
      .get(pluginId, key) as { value: string } | undefined;
    return row?.value;
  }

  setPluginKv(pluginId: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(pluginId, key, value);
  }

  deletePluginKv(pluginId: string, key: string): void {
    this.db.prepare("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?").run(pluginId, key);
  }

  // -- journal -----------------------------------------------------------
  appendJournal(row: Omit<JournalRow, "id">): number {
    const result = this.db
      .prepare(
        `INSERT INTO journal (plan_id, step, payload_json, result, ts) VALUES (@plan_id, @step, @payload_json, @result, @ts)`,
      )
      .run(row);
    return Number(result.lastInsertRowid);
  }

  listJournal(planId: string): JournalRow[] {
    return this.db.prepare("SELECT * FROM journal WHERE plan_id = ? ORDER BY id").all(planId) as JournalRow[];
  }
}
