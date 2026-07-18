import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./migrations.js";
import { hostsInCidr } from "../ipam/cidr.js";

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

export interface IpamRangeRow {
  id: string;
  cidr: string;
  gateway: string;
}

export interface IpamAllocationRow {
  ip: string;
  range_id: string;
  allocated_at: string;
  released_at: string | null;
  /** Stable idempotency key (e.g. `EndpointRequest.purpose`) so a repeat `allocateIp(rangeId, owner)` call for the same logical resource reuses its existing address instead of minting a new one every reconcile. Null for pre-owner-column rows and for callers that never pass one (kept legacy-compatible; those always allocate fresh, same as before). */
  owner: string | null;
}

export class IpamExhaustedError extends Error {}

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
    // Re-trusting the same (plugin_id, version) after an untrust is legal
    // (the operator un-trusted, then decided to trust it again): untrust
    // never deletes the row (audit history must survive), so this upserts
    // rather than raw-inserting, clearing revoked_at on the new trust.
    this.db
      .prepare(
        `INSERT INTO trust_records (plugin_id, version, sha256, granted_caps_json, sig, created_at)
         VALUES (@plugin_id, @version, @sha256, @granted_caps_json, @sig, @created_at)
         ON CONFLICT(plugin_id, version) DO UPDATE SET
           sha256 = excluded.sha256,
           granted_caps_json = excluded.granted_caps_json,
           sig = excluded.sig,
           created_at = excluded.created_at,
           revoked_at = NULL`,
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

  // -- framework doc (T5.3, docs/t5.3-decisions.md) ------------------------
  /** The framework document's raw (already-validated) envelope, or undefined pre-init. Lives here, not `wanfw_desired`, since the admin socket -- not tier1 -- is the only legitimate author (§12.5's own tier1/orchestrator trust split). */
  getFrameworkDoc(): unknown | undefined {
    const raw = this.getMeta("framework_doc");
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  }

  setFrameworkDoc(raw: unknown): void {
    this.setMeta("framework_doc", JSON.stringify(raw));
  }

  // -- operator info (T5.5) -------------------------------------------------
  /** The wizard's own operator instructions (DNS record, forward target, WAN IP at the time `wanfwctl init` ran), captured so tier1's setup page can mirror them read-only -- same "write once via admin.sock, mirror via status-socket" shape as the framework doc itself. */
  getOperatorInfo(): unknown | undefined {
    const raw = this.getMeta("operator_info");
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  }

  setOperatorInfo(raw: unknown): void {
    this.setMeta("operator_info", JSON.stringify(raw));
  }

  // -- ipam (T5.1, ADR-1) -------------------------------------------------
  /** Idempotent: called on every reconcile load from `framework.spec.network.macvlan` to keep the range in sync with the current desired state (a changed CIDR/gateway just updates the row in place -- existing allocations outside the new CIDR are left alone rather than force-released, since that's a network-provider-level decision, not this table's). */
  setIpamRange(row: IpamRangeRow): void {
    this.db
      .prepare(
        `INSERT INTO ipam_ranges (id, cidr, gateway) VALUES (@id, @cidr, @gateway)
         ON CONFLICT(id) DO UPDATE SET cidr = excluded.cidr, gateway = excluded.gateway`,
      )
      .run(row);
  }

  getIpamRange(id: string): IpamRangeRow | undefined {
    return this.db.prepare("SELECT * FROM ipam_ranges WHERE id = ?").get(id) as IpamRangeRow | undefined;
  }

  /**
   * `ipam.allocate(rangeId, owner?)` (§6.6, ADR-1): the *first* host
   * address in the range's CIDR (excluding network, broadcast, and the
   * range's own gateway) that has no live allocation row -- a released IP
   * is eligible for reuse immediately, but a currently-allocated one, or
   * an address outside the current CIDR, never is. Runs inside a
   * transaction so two concurrent allocate calls can never race onto the
   * same IP (the PRIMARY KEY insert would fail the loser, but a
   * transaction avoids ever attempting the collision in the first place --
   * fewer surprising error paths for a network-provider plugin driving
   * this).
   *
   * `owner` is an idempotency key for a stable logical resource (e.g. the
   * macvlan proxy's own static IP, keyed by `EndpointRequest.purpose`):
   * when given and a live allocation already exists for this exact
   * `(rangeId, owner)` pair, that same IP is returned rather than minting
   * a new one. Without this, a caller that re-plans on every reconcile
   * (as PLAN does, every ~60s) would permanently leak one address per
   * cycle -- found in production exhausting a real deployment's reserved
   * range within days. Omitting `owner` keeps the old always-allocate-fresh
   * behavior, for callers that genuinely want a new address every time.
   */
  allocateIp(rangeId: string, owner?: string): string {
    return this.db.transaction(() => {
      const range = this.getIpamRange(rangeId);
      if (!range) throw new Error(`no ipam range registered with id '${rangeId}'`);

      if (owner) {
        const existing = this.db
          .prepare("SELECT ip FROM ipam_allocations WHERE range_id = ? AND owner = ? AND released_at IS NULL")
          .get(rangeId, owner) as { ip: string } | undefined;
        if (existing) return existing.ip;
      }

      const allocated = new Set(
        (
          this.db.prepare("SELECT ip FROM ipam_allocations WHERE range_id = ? AND released_at IS NULL").all(rangeId) as Array<{
            ip: string;
          }>
        ).map((r) => r.ip),
      );

      const candidate = hostsInCidr(range.cidr, range.gateway).find((ip) => !allocated.has(ip));
      if (!candidate) {
        throw new IpamExhaustedError(`ipam range '${rangeId}' (${range.cidr}) has no free addresses`);
      }

      this.db
        .prepare(
          `INSERT INTO ipam_allocations (ip, range_id, allocated_at, owner) VALUES (?, ?, ?, ?)
           ON CONFLICT(ip) DO UPDATE SET range_id = excluded.range_id, allocated_at = excluded.allocated_at, released_at = NULL, owner = excluded.owner`,
        )
        .run(candidate, rangeId, new Date().toISOString(), owner ?? null);

      return candidate;
    })();
  }

  /** `ipam.release(ip)`: soft-release (keeps the row, for audit, same discipline as trust/grant/approval revocation) -- releasing an address that was never allocated, or is already released, is a no-op, not an error (mirrors §9's general "cleanup is idempotent" discipline). */
  releaseIp(ip: string): void {
    this.db
      .prepare("UPDATE ipam_allocations SET released_at = ? WHERE ip = ? AND released_at IS NULL")
      .run(new Date().toISOString(), ip);
  }

  listIpamAllocations(rangeId: string, includeReleased = false): IpamAllocationRow[] {
    const sql = includeReleased
      ? "SELECT * FROM ipam_allocations WHERE range_id = ? ORDER BY ip"
      : "SELECT * FROM ipam_allocations WHERE range_id = ? AND released_at IS NULL ORDER BY ip";
    return this.db.prepare(sql).all(rangeId) as IpamAllocationRow[];
  }
}
