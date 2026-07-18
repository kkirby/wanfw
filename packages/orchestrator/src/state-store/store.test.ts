import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { StateStore, IpamExhaustedError } from "./store.js";
import { MIGRATIONS } from "./migrations.js";

describe("StateStore", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function openTestStore(): { store: StateStore; dbPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "wanfw-state-"));
    dirs.push(dir);
    const dbPath = join(dir, "state.sqlite3");
    const store = new StateStore(dbPath);
    stores.push(store);
    return { store, dbPath };
  }

  it("creates the db file with 0600 permissions", () => {
    const { dbPath } = openTestStore();
    const mode = statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("running the constructor twice against the same file is idempotent (migrations don't re-run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wanfw-state-"));
    dirs.push(dir);
    const dbPath = join(dir, "state.sqlite3");
    const first = new StateStore(dbPath);
    first.setMeta("foo", "bar");
    first.close();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.getMeta("foo")).toBe("bar");
  });

  it("meta: set/get round-trips and upserts", () => {
    const { store } = openTestStore();
    expect(store.getMeta("k")).toBeUndefined();
    store.setMeta("k", "v1");
    expect(store.getMeta("k")).toBe("v1");
    store.setMeta("k", "v2");
    expect(store.getMeta("k")).toBe("v2");
  });

  it("trust_records: insert/get/list/revoke", () => {
    const { store } = openTestStore();
    store.insertTrustRecord({
      plugin_id: "deploy-docker",
      version: "0.1.0",
      sha256: "abc123",
      granted_caps_json: "[]",
      sig: "sig1",
      created_at: new Date().toISOString(),
    });

    const record = store.getTrustRecord("deploy-docker", "0.1.0");
    expect(record?.sha256).toBe("abc123");
    expect(store.listTrustRecords()).toHaveLength(1);

    store.revokeTrustRecord("deploy-docker", "0.1.0");
    expect(store.listTrustRecords()).toHaveLength(0);
    expect(store.listTrustRecords(true)).toHaveLength(1);
  });

  it("trust_records: re-trusting the same (plugin_id, version) after untrust upserts and clears revoked_at", () => {
    const { store } = openTestStore();
    const insert = (sha256: string) =>
      store.insertTrustRecord({
        plugin_id: "deploy-docker",
        version: "0.1.0",
        sha256,
        granted_caps_json: "[]",
        sig: "sig1",
        created_at: new Date().toISOString(),
      });

    insert("abc123");
    store.revokeTrustRecord("deploy-docker", "0.1.0");
    expect(store.listTrustRecords()).toHaveLength(0);

    // Re-trust with a new hash (e.g. a re-staged, functionally identical bundle).
    insert("def456");
    const live = store.listTrustRecords();
    expect(live).toHaveLength(1);
    expect(live[0]?.sha256).toBe("def456");
    expect(live[0]?.revoked_at).toBeNull();
  });

  it("grants: insert/list/revoke, scoped per plugin", () => {
    const { store } = openTestStore();
    const id = store.insertGrant({
      plugin_id: "deploy-docker",
      cap: "docker.device",
      scope_json: JSON.stringify({ paths: ["/dev/dri/*"] }),
      sig: "sig1",
      created_at: new Date().toISOString(),
    });

    expect(store.listGrants("deploy-docker")).toHaveLength(1);
    expect(store.listGrants("other-plugin")).toHaveLength(0);

    store.revokeGrant(id);
    expect(store.listGrants("deploy-docker")).toHaveLength(0);
    expect(store.listGrants("deploy-docker", true)).toHaveLength(1);
  });

  it("approvals: insert/get/isApproved/revoke", () => {
    const { store } = openTestStore();
    const hash = "projhash1";
    expect(store.isApproved(hash)).toBe(false);

    store.insertApproval({
      projection_hash: hash,
      service_id: "jellyfin",
      human_rendering: "bind mount /srv/media read-only",
      sig: "sig1",
      approved_at: new Date().toISOString(),
    });
    expect(store.isApproved(hash)).toBe(true);

    store.revokeApproval(hash);
    expect(store.isApproved(hash)).toBe(false);
    expect(store.listApprovals(true)).toHaveLength(1);
  });

  it("approvals: re-approving after revoke clears revoked_at", () => {
    const { store } = openTestStore();
    const hash = "projhash2";
    store.insertApproval({
      projection_hash: hash,
      service_id: "jellyfin",
      human_rendering: "x",
      sig: "sig1",
      approved_at: new Date().toISOString(),
    });
    store.revokeApproval(hash);
    expect(store.isApproved(hash)).toBe(false);

    store.insertApproval({
      projection_hash: hash,
      service_id: "jellyfin",
      human_rendering: "x",
      sig: "sig2",
      approved_at: new Date().toISOString(),
    });
    expect(store.isApproved(hash)).toBe(true);
  });

  it("plugin_kv: namespaced by plugin_id", () => {
    const { store } = openTestStore();
    store.setPluginKv("plugin-a", "key1", "value-a");
    store.setPluginKv("plugin-b", "key1", "value-b");
    expect(store.getPluginKv("plugin-a", "key1")).toBe("value-a");
    expect(store.getPluginKv("plugin-b", "key1")).toBe("value-b");

    store.deletePluginKv("plugin-a", "key1");
    expect(store.getPluginKv("plugin-a", "key1")).toBeUndefined();
    expect(store.getPluginKv("plugin-b", "key1")).toBe("value-b");
  });

  it("journal: append and list ordered by insertion, scoped by plan_id", () => {
    const { store } = openTestStore();
    store.appendJournal({ plan_id: "plan1", step: "ensureNetwork", payload_json: "{}", result: "ok", ts: "1" });
    store.appendJournal({ plan_id: "plan1", step: "ensureContainer", payload_json: "{}", result: "ok", ts: "2" });
    store.appendJournal({ plan_id: "plan2", step: "ensureNetwork", payload_json: "{}", result: "ok", ts: "3" });

    const plan1 = store.listJournal("plan1");
    expect(plan1.map((r) => r.step)).toEqual(["ensureNetwork", "ensureContainer"]);
    expect(store.listJournal("plan2")).toHaveLength(1);
  });

  describe("ipam (T5.1, ADR-1)", () => {
    it("setIpamRange then getIpamRange round-trips, and re-setting the same id updates in place", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.1" });
      expect(store.getIpamRange("macvlan")).toEqual({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.1" });

      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.248/29", gateway: "192.168.1.1" });
      expect(store.getIpamRange("macvlan")?.cidr).toBe("192.168.1.248/29");
    });

    it("getIpamRange returns undefined for an id that was never registered", () => {
      const { store } = openTestStore();
      expect(store.getIpamRange("never-registered")).toBeUndefined();
    });

    it("allocateIp throws for an unregistered range", () => {
      const { store } = openTestStore();
      expect(() => store.allocateIp("nope")).toThrow(/no ipam range registered/);
    });

    it("allocateIp hands out the first free host in the CIDR, excluding the gateway, in order", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });
      expect(store.allocateIp("macvlan")).toBe("192.168.1.242");
      expect(store.allocateIp("macvlan")).toBe("192.168.1.243");
    });

    it("exhaustion: allocating past every free address throws IpamExhaustedError", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "tiny", cidr: "10.0.0.0/30", gateway: "10.0.0.1" }); // one usable host after excluding network/broadcast/gateway... actually /30 has 2 hosts, minus gateway = 1
      store.allocateIp("tiny");
      expect(() => store.allocateIp("tiny")).toThrow(IpamExhaustedError);
      expect(() => store.allocateIp("tiny")).toThrow(/no free addresses/);
    });

    it("allocateIp with an owner reuses the same address on repeat calls instead of leaking a fresh one every time", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });
      const first = store.allocateIp("macvlan", "shared-proxy");
      const second = store.allocateIp("macvlan", "shared-proxy");
      const third = store.allocateIp("macvlan", "shared-proxy");
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(store.listIpamAllocations("macvlan")).toHaveLength(1);
    });

    it("allocateIp with different owners gets distinct addresses", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });
      const a = store.allocateIp("macvlan", "shared-proxy");
      const b = store.allocateIp("macvlan", "dedicated-proxy");
      expect(a).not.toBe(b);
      expect(store.listIpamAllocations("macvlan")).toHaveLength(2);
    });

    it("allocateIp without an owner keeps allocating fresh addresses every call (legacy behavior)", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });
      const a = store.allocateIp("macvlan");
      const b = store.allocateIp("macvlan");
      expect(a).not.toBe(b);
    });

    it("allocateIp with an owner re-allocates a fresh address once the owned one has been released", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });
      const first = store.allocateIp("macvlan", "shared-proxy");
      store.releaseIp(first);
      const second = store.allocateIp("macvlan", "shared-proxy");
      expect(second).toBe(first); // still the first free host in the CIDR, just re-allocated
      // Same IP -> same PRIMARY KEY row, upserted in place, not a new row.
      expect(store.listIpamAllocations("macvlan", true)).toHaveLength(1);
    });

    it("releaseIp frees the address for immediate reallocation", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "tiny", cidr: "10.0.0.0/30", gateway: "10.0.0.1" });
      const ip = store.allocateIp("tiny");
      expect(() => store.allocateIp("tiny")).toThrow(IpamExhaustedError);

      store.releaseIp(ip);
      expect(store.allocateIp("tiny")).toBe(ip);
    });

    it("releaseIp on a never-allocated or already-released address is a silent no-op, not an error", () => {
      const { store } = openTestStore();
      expect(() => store.releaseIp("10.0.0.99")).not.toThrow();

      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });
      const ip = store.allocateIp("macvlan");
      store.releaseIp(ip);
      expect(() => store.releaseIp(ip)).not.toThrow(); // double-release
    });

    it("double-release does not corrupt allocation state -- the address is still available exactly once", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "tiny", cidr: "10.0.0.0/30", gateway: "10.0.0.1" });
      const ip = store.allocateIp("tiny");
      store.releaseIp(ip);
      store.releaseIp(ip);
      expect(store.allocateIp("tiny")).toBe(ip);
      expect(() => store.allocateIp("tiny")).toThrow(IpamExhaustedError);
    });

    it("allocations are scoped per range_id -- two ranges never collide or interfere", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "range-a", cidr: "10.0.0.0/29", gateway: "10.0.0.1" });
      store.setIpamRange({ id: "range-b", cidr: "10.0.1.0/29", gateway: "10.0.1.1" });
      const a = store.allocateIp("range-a");
      const b = store.allocateIp("range-b");
      expect(a.startsWith("10.0.0.")).toBe(true);
      expect(b.startsWith("10.0.1.")).toBe(true);
      expect(store.listIpamAllocations("range-a")).toHaveLength(1);
      expect(store.listIpamAllocations("range-b")).toHaveLength(1);
    });

    it("listIpamAllocations excludes released allocations unless includeReleased is set", () => {
      const { store } = openTestStore();
      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });
      store.allocateIp("macvlan"); // stays live
      const second = store.allocateIp("macvlan");
      store.releaseIp(second); // released, but its row still exists

      expect(store.listIpamAllocations("macvlan")).toHaveLength(1);
      expect(store.listIpamAllocations("macvlan", true)).toHaveLength(2);
    });

    it("allocations survive a fresh StateStore instance against the same db file (restart)", () => {
      const dir = mkdtempSync(join(tmpdir(), "wanfw-state-"));
      dirs.push(dir);
      const dbPath = join(dir, "state.sqlite3");
      const first = new StateStore(dbPath);
      first.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });
      const ip = first.allocateIp("macvlan");
      first.close();

      const second = new StateStore(dbPath);
      stores.push(second);
      expect(second.getIpamRange("macvlan")?.cidr).toBe("192.168.1.240/29");
      expect(second.listIpamAllocations("macvlan").map((r) => r.ip)).toEqual([ip]);
      // the "restarted" allocation table is still authoritative -- the same address is still taken
      const allocatedNow = new Set(second.listIpamAllocations("macvlan").map((r) => r.ip));
      expect(allocatedNow.has(ip)).toBe(true);
    });

    it("migration 2 self-heals a range already exhausted by the pre-owner-column leak, by releasing every orphaned (ownerless) allocation", () => {
      // Simulates a db that only ever saw migration 1 (pre-fix): every
      // reconcile minted a fresh, never-released allocation with no
      // owner, eventually exhausting the range -- exactly the leak found
      // in production. Hand-builds that state with raw better-sqlite3
      // (StateStore always applies every migration, so this is the only
      // way to reproduce a "stuck on migration 1" db), then opens it via
      // StateStore and confirms migration 2 releases the leaked rows so
      // the range is usable again.
      const dir = mkdtempSync(join(tmpdir(), "wanfw-state-"));
      dirs.push(dir);
      const dbPath = join(dir, "state.sqlite3");

      const raw = new Database(dbPath);
      raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
      raw.exec(MIGRATIONS[0]!.sql);
      raw.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (1, ?)").run(new Date().toISOString());
      raw.prepare("INSERT INTO ipam_ranges (id, cidr, gateway) VALUES ('macvlan', '10.0.0.0/29', '10.0.0.1')").run();
      // Fill every usable host (10.0.0.2..10.0.0.6) with leaked, unreleased, ownerless allocations.
      for (const ip of ["10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5", "10.0.0.6"]) {
        raw.prepare("INSERT INTO ipam_allocations (ip, range_id, allocated_at) VALUES (?, 'macvlan', ?)").run(ip, new Date().toISOString());
      }
      raw.close();

      const store = new StateStore(dbPath);
      stores.push(store);

      // Every previously-leaked row is now released (self-healed)...
      expect(store.listIpamAllocations("macvlan")).toHaveLength(0);
      expect(store.listIpamAllocations("macvlan", true)).toHaveLength(5);
      // ...so the range is usable again, and owner-based reuse works from here on.
      const ip = store.allocateIp("macvlan", "shared-proxy");
      expect(store.allocateIp("macvlan", "shared-proxy")).toBe(ip);
    });
  });
});
