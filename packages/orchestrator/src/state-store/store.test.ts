import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "./store.js";

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
});
