import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state-store/store.js";
import { createLogger } from "../logger.js";
import { buildHostApiDispatcher, CapabilityError } from "./dispatcher.js";
import type { FrameworkRolesHolder } from "../reconciler/core-stages.js";
import type { PluginInvoker, PluginInvokeResult } from "../reconciler/plan-stage.js";
import { currentCertPaths } from "../certs/store.js";

describe("buildHostApiDispatcher", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function freshDispatcher(options?: {
    roles?: Record<string, string>;
    pluginInvoker?: PluginInvoker;
    probeNetwork?: (mode: "macvlan", parent: string) => Promise<{ ok: boolean; reason?: string }>;
  }) {
    const dir = mkdtempSync(join(tmpdir(), "wanfw-hostapi-"));
    dirs.push(dir);
    const secretsDir = mkdtempSync(join(tmpdir(), "wanfw-secrets-"));
    dirs.push(secretsDir);
    const certsDir = mkdtempSync(join(tmpdir(), "wanfw-certs-"));
    dirs.push(certsDir);
    const bundlesDir = mkdtempSync(join(tmpdir(), "wanfw-bundles-"));
    dirs.push(bundlesDir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    stores.push(store);
    const rolesHolder: FrameworkRolesHolder = { roles: options?.roles ?? {} };
    const pluginInvoker: PluginInvoker = options?.pluginInvoker ?? (async () => ({ ok: true, result: {} }));
    const dispatch = buildHostApiDispatcher({
      store,
      log: createLogger("test"),
      secretsDir,
      certsDir,
      bundlesDir,
      rolesHolder,
      pluginInvoker,
      probeNetwork: options?.probeNetwork,
    });
    return { dispatch, store, secretsDir, certsDir, bundlesDir, rolesHolder };
  }

  function grant(store: StateStore, pluginId: string, cap: string, scope: Record<string, unknown>): void {
    store.insertGrant({ plugin_id: pluginId, cap, scope_json: JSON.stringify(scope), sig: "sig", created_at: new Date().toISOString() });
  }

  /** Trusts `pluginId` with a real manifest.json (declaring `types`) staged under `bundlesDir/<sha256>`, so `callingPluginTypes`'s structural check has something real to read -- mirrors how a real plugin's trust record + bundle actually relate. */
  function trustAsType(store: StateStore, bundlesDir: string, pluginId: string, types: string[]): void {
    const sha256 = `${pluginId}-sha`;
    mkdirSync(join(bundlesDir, sha256), { recursive: true });
    writeFileSync(join(bundlesDir, sha256, "manifest.json"), JSON.stringify({ id: pluginId, version: "0.1.0", types }));
    store.insertTrustRecord({
      plugin_id: pluginId,
      version: "0.1.0",
      sha256,
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });
  }

  it("state.put then state.get round-trips within a plugin's own namespace", async () => {
    const { dispatch } = freshDispatcher();
    await dispatch({ invocationId: "i1", pluginId: "deploy-docker", method: "state.put", args: { key: "k", value: "v" } });
    const res = await dispatch({ invocationId: "i1", pluginId: "deploy-docker", method: "state.get", args: { key: "k" } });
    expect(res).toEqual({ value: "v" });
  });

  it("state.get returns null for a key that was never set", async () => {
    const { dispatch } = freshDispatcher();
    const res = await dispatch({ invocationId: "i1", pluginId: "deploy-docker", method: "state.get", args: { key: "nope" } });
    expect(res).toEqual({ value: null });
  });

  it("cross-namespace reads are structurally impossible: plugin B never sees plugin A's key", async () => {
    const { dispatch } = freshDispatcher();
    await dispatch({ invocationId: "i1", pluginId: "plugin-a", method: "state.put", args: { key: "k", value: "secret-a" } });
    const res = await dispatch({ invocationId: "i2", pluginId: "plugin-b", method: "state.get", args: { key: "k" } });
    expect(res).toEqual({ value: null });
  });

  it("state.delete removes only the calling plugin's own key", async () => {
    const { dispatch } = freshDispatcher();
    await dispatch({ invocationId: "i1", pluginId: "plugin-a", method: "state.put", args: { key: "k", value: "v" } });
    await dispatch({ invocationId: "i1", pluginId: "plugin-b", method: "state.put", args: { key: "k", value: "v" } });
    await dispatch({ invocationId: "i1", pluginId: "plugin-a", method: "state.delete", args: { key: "k" } });
    expect(await dispatch({ invocationId: "i1", pluginId: "plugin-a", method: "state.get", args: { key: "k" } })).toEqual({
      value: null,
    });
    expect(await dispatch({ invocationId: "i1", pluginId: "plugin-b", method: "state.get", args: { key: "k" } })).toEqual({
      value: "v",
    });
  });

  it("log.emit is always allowed and never throws", async () => {
    const { dispatch } = freshDispatcher();
    await expect(
      dispatch({ invocationId: "i1", pluginId: "any-plugin", method: "log.emit", args: { level: "info", msg: "hi" } }),
    ).resolves.toEqual({});
  });

  it("an unknown method is rejected with a CapabilityError", async () => {
    const { dispatch } = freshDispatcher();
    await expect(
      dispatch({ invocationId: "i1", pluginId: "deploy-docker", method: "docker.rawExec", args: {} }),
    ).rejects.toThrow(CapabilityError);
  });

  describe("secrets.get/put (T4.1, capability-gated -- the first live-call grant check in this dispatcher)", () => {
    it("secrets.put then secrets.get round-trips when the plugin holds a covering secrets.write/read grant", async () => {
      const { dispatch, store } = freshDispatcher();
      grant(store, "cert-letsencrypt-dns01", "secrets.write", { names: ["cert-letsencrypt-dns01/*"] });
      grant(store, "cert-letsencrypt-dns01", "secrets.read", { names: ["cert-letsencrypt-dns01/*"] });

      await dispatch({
        invocationId: "i1",
        pluginId: "cert-letsencrypt-dns01",
        method: "secrets.put",
        args: { name: "cert-letsencrypt-dns01/acme-account-key", value: "top-secret" },
      });
      const res = await dispatch({
        invocationId: "i2",
        pluginId: "cert-letsencrypt-dns01",
        method: "secrets.get",
        args: { name: "cert-letsencrypt-dns01/acme-account-key" },
      });
      expect(res).toEqual({ value: "top-secret" });
    });

    it("secrets.get denies a plugin with no covering grant", async () => {
      const { dispatch } = freshDispatcher();
      await expect(
        dispatch({
          invocationId: "i1",
          pluginId: "deploy-docker",
          method: "secrets.get",
          args: { name: "cert-letsencrypt-dns01/acme-account-key" },
        }),
      ).rejects.toThrow(CapabilityError);
    });

    it("secrets.put denies writing outside the plugin's own granted namespace -- grants are never trusted from the invocation payload (invariant #8), only loaded fresh from the store", async () => {
      const { dispatch, store } = freshDispatcher();
      grant(store, "dns-namecheap", "secrets.write", { names: ["dns-namecheap/*"] });

      await expect(
        dispatch({
          invocationId: "i1",
          pluginId: "dns-namecheap",
          method: "secrets.put",
          args: { name: "cert-letsencrypt-dns01/acme-account-key", value: "steal-me" },
        }),
      ).rejects.toThrow(CapabilityError);
    });

    it("secrets.get returns null (not an error) for a covered name that was never set", async () => {
      const { dispatch, store } = freshDispatcher();
      grant(store, "cert-letsencrypt-dns01", "secrets.read", { names: ["cert-letsencrypt-dns01/*"] });
      const res = await dispatch({
        invocationId: "i1",
        pluginId: "cert-letsencrypt-dns01",
        method: "secrets.get",
        args: { name: "cert-letsencrypt-dns01/never-set" },
      });
      expect(res).toEqual({ value: null });
    });

    it("a revoked grant is re-checked live: revoking secrets.write between two calls blocks the second one, proving grants are loaded fresh every invocation, not cached", async () => {
      const { dispatch, store } = freshDispatcher();
      const grantId = store.insertGrant({
        plugin_id: "cert-letsencrypt-dns01",
        cap: "secrets.write",
        scope_json: JSON.stringify({ names: ["cert-letsencrypt-dns01/*"] }),
        sig: "sig",
        created_at: new Date().toISOString(),
      });

      await dispatch({
        invocationId: "i1",
        pluginId: "cert-letsencrypt-dns01",
        method: "secrets.put",
        args: { name: "cert-letsencrypt-dns01/k", value: "v1" },
      });

      store.revokeGrant(grantId);

      await expect(
        dispatch({
          invocationId: "i2",
          pluginId: "cert-letsencrypt-dns01",
          method: "secrets.put",
          args: { name: "cert-letsencrypt-dns01/k", value: "v2" },
        }),
      ).rejects.toThrow(CapabilityError);
    });
  });

  describe("dns.setRecord/deleteRecord broker + dns.query (T4.3)", () => {
    it("brokers a covering dns.record.write call to the bound dnsProvider plugin's dns.apply task -- the calling plugin never talks to it directly", async () => {
      const invokeCalls: unknown[] = [];
      const { dispatch, store } = freshDispatcher({
        roles: { dnsProvider: "dns-namecheap" },
        pluginInvoker: async (pluginId, task, input) => {
          invokeCalls.push({ pluginId, task, input });
          return { ok: true, result: {} };
        },
      });
      grant(store, "cert-letsencrypt-dns01", "dns.record.write", { zones: ["example.tld"] });

      const res = await dispatch({
        invocationId: "i1",
        pluginId: "cert-letsencrypt-dns01",
        method: "dns.setRecord",
        args: { zone: "example.tld", record: { type: "TXT", name: "_acme-challenge", value: "token" } },
      });

      expect(res).toEqual({});
      expect(invokeCalls).toEqual([
        {
          pluginId: "dns-namecheap",
          task: "dns.apply",
          input: { zone: "example.tld", action: "set", record: { type: "TXT", name: "_acme-challenge", value: "token" } },
        },
      ]);
    });

    it("dns.deleteRecord brokers with action: 'delete'", async () => {
      const invokeCalls: unknown[] = [];
      const { dispatch, store } = freshDispatcher({
        roles: { dnsProvider: "dns-namecheap" },
        pluginInvoker: async (pluginId, task, input) => {
          invokeCalls.push({ pluginId, task, input });
          return { ok: true, result: {} };
        },
      });
      grant(store, "cert-letsencrypt-dns01", "dns.record.write", { zones: ["example.tld"] });

      await dispatch({
        invocationId: "i1",
        pluginId: "cert-letsencrypt-dns01",
        method: "dns.deleteRecord",
        args: { zone: "example.tld", record: { type: "TXT", name: "_acme-challenge", value: "token" } },
      });

      expect((invokeCalls[0] as { input: { action: string } }).input.action).toBe("delete");
    });

    it("denies a plugin with no dns.record.write grant covering the zone", async () => {
      const { dispatch } = freshDispatcher({ roles: { dnsProvider: "dns-namecheap" } });
      await expect(
        dispatch({
          invocationId: "i1",
          pluginId: "cert-letsencrypt-dns01",
          method: "dns.setRecord",
          args: { zone: "example.tld", record: { type: "TXT", name: "x", value: "y" } },
        }),
      ).rejects.toThrow(CapabilityError);
    });

    it("denies a grant scoped to a different zone -- zone confinement isn't 'has any dns.record.write grant'", async () => {
      const { dispatch, store } = freshDispatcher({ roles: { dnsProvider: "dns-namecheap" } });
      grant(store, "cert-letsencrypt-dns01", "dns.record.write", { zones: ["other.tld"] });
      await expect(
        dispatch({
          invocationId: "i1",
          pluginId: "cert-letsencrypt-dns01",
          method: "dns.setRecord",
          args: { zone: "example.tld", record: { type: "TXT", name: "x", value: "y" } },
        }),
      ).rejects.toThrow(CapabilityError);
    });

    it("fails clearly when no dnsProvider role is currently bound, even with a covering grant", async () => {
      const { dispatch, store } = freshDispatcher({ roles: {} });
      grant(store, "cert-letsencrypt-dns01", "dns.record.write", { zones: ["example.tld"] });
      await expect(
        dispatch({
          invocationId: "i1",
          pluginId: "cert-letsencrypt-dns01",
          method: "dns.setRecord",
          args: { zone: "example.tld", record: { type: "TXT", name: "x", value: "y" } },
        }),
      ).rejects.toThrow(/no dnsProvider role/);
    });

    it("propagates the dns-provider plugin's own failure (e.g. Namecheap's IP-allowlist error) back to the caller", async () => {
      const { dispatch, store } = freshDispatcher({
        roles: { dnsProvider: "dns-namecheap" },
        pluginInvoker: async () => ({ ok: false, error: { code: "invoke_error", message: "add this host's WAN IP to the allowlist" } }),
      });
      grant(store, "cert-letsencrypt-dns01", "dns.record.write", { zones: ["example.tld"] });
      await expect(
        dispatch({
          invocationId: "i1",
          pluginId: "cert-letsencrypt-dns01",
          method: "dns.setRecord",
          args: { zone: "example.tld", record: { type: "TXT", name: "x", value: "y" } },
        }),
      ).rejects.toThrow(/allowlist/);
    });

    it("dns.query performs no resolution itself -- it's advisory logging only, always succeeds, never touches grants or the plugin invoker", async () => {
      let invoked = false;
      const { dispatch } = freshDispatcher({
        pluginInvoker: async (): Promise<PluginInvokeResult> => {
          invoked = true;
          return { ok: true, result: {} };
        },
      });
      const res = await dispatch({
        invocationId: "i1",
        pluginId: "cert-letsencrypt-dns01",
        method: "dns.query",
        args: { name: "_acme-challenge.example.tld", type: "TXT", result: ["token"] },
      });
      expect(res).toEqual({});
      expect(invoked).toBe(false);
    });
  });

  describe("certs.store (T4.5)", () => {
    it("a granted plugin's certs.store call writes the cert and returns the new generation", async () => {
      const { dispatch, store, certsDir } = freshDispatcher();
      grant(store, "cert-letsencrypt-dns01", "certs.store", {});

      const res = await dispatch({
        invocationId: "i1",
        pluginId: "cert-letsencrypt-dns01",
        method: "certs.store",
        args: { name: "wildcard", certPem: "CERT", keyPem: "KEY", meta: { names: ["example.tld"] } },
      });

      expect(res).toEqual({ generation: 1 });
      expect(currentCertPaths(certsDir, "wildcard")).toBeDefined();
    });

    it("denies a plugin with no certs.store grant", async () => {
      const { dispatch } = freshDispatcher();
      await expect(
        dispatch({
          invocationId: "i1",
          pluginId: "cert-letsencrypt-dns01",
          method: "certs.store",
          args: { name: "wildcard", certPem: "CERT", keyPem: "KEY" },
        }),
      ).rejects.toThrow(CapabilityError);
    });

    it("calls onCertChange after a successful store, to trigger an immediate reconcile", async () => {
      let changed = false;
      const dir = mkdtempSync(join(tmpdir(), "wanfw-hostapi-"));
      dirs.push(dir);
      const secretsDir = mkdtempSync(join(tmpdir(), "wanfw-secrets-"));
      dirs.push(secretsDir);
      const certsDir = mkdtempSync(join(tmpdir(), "wanfw-certs-"));
      dirs.push(certsDir);
      const bundlesDir = mkdtempSync(join(tmpdir(), "wanfw-bundles-"));
      dirs.push(bundlesDir);
      const store = new StateStore(join(dir, "state.sqlite3"));
      stores.push(store);
      grant(store, "cert-letsencrypt-dns01", "certs.store", {});
      const dispatch = buildHostApiDispatcher({
        store,
        log: createLogger("test"),
        secretsDir,
        certsDir,
        bundlesDir,
        rolesHolder: { roles: {} },
        pluginInvoker: async () => ({ ok: true, result: {} }),
        onCertChange: () => {
          changed = true;
        },
      });

      await dispatch({
        invocationId: "i1",
        pluginId: "cert-letsencrypt-dns01",
        method: "certs.store",
        args: { name: "wildcard", certPem: "CERT", keyPem: "KEY" },
      });

      expect(changed).toBe(true);
    });
  });

  describe("ipam.allocate / ipam.release (T5.1)", () => {
    it("a trusted network-provider plugin can allocate and release, structurally (no grant required)", async () => {
      const { dispatch, store, bundlesDir } = freshDispatcher();
      trustAsType(store, bundlesDir, "network-macvlan", ["network-provider"]);
      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });

      const res = await dispatch({ invocationId: "i1", pluginId: "network-macvlan", method: "ipam.allocate", args: { rangeId: "macvlan" } });
      expect(res).toEqual({ ip: "192.168.1.242" });

      const releaseRes = await dispatch({ invocationId: "i2", pluginId: "network-macvlan", method: "ipam.release", args: { ip: "192.168.1.242" } });
      expect(releaseRes).toEqual({});
      expect(store.listIpamAllocations("macvlan")).toHaveLength(0);
    });

    it("ipam.allocate with an owner reuses the same address on repeat calls, instead of leaking a fresh one every reconcile", async () => {
      const { dispatch, store, bundlesDir } = freshDispatcher();
      trustAsType(store, bundlesDir, "network-macvlan", ["network-provider"]);
      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });

      const first = await dispatch({
        invocationId: "i1",
        pluginId: "network-macvlan",
        method: "ipam.allocate",
        args: { rangeId: "macvlan", owner: "shared-proxy" },
      });
      const second = await dispatch({
        invocationId: "i2",
        pluginId: "network-macvlan",
        method: "ipam.allocate",
        args: { rangeId: "macvlan", owner: "shared-proxy" },
      });
      expect(second).toEqual(first);
      expect(store.listIpamAllocations("macvlan")).toHaveLength(1);
    });

    it("denies ipam.allocate for a plugin that isn't a trusted network-provider type", async () => {
      const { dispatch, store, bundlesDir } = freshDispatcher();
      trustAsType(store, bundlesDir, "dns-namecheap", ["dns-provider"]);
      store.setIpamRange({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });

      await expect(
        dispatch({ invocationId: "i1", pluginId: "dns-namecheap", method: "ipam.allocate", args: { rangeId: "macvlan" } }),
      ).rejects.toThrow(CapabilityError);
    });

    it("denies ipam.allocate for a plugin that isn't trusted at all", async () => {
      const { dispatch } = freshDispatcher();
      await expect(
        dispatch({ invocationId: "i1", pluginId: "not-trusted", method: "ipam.allocate", args: { rangeId: "macvlan" } }),
      ).rejects.toThrow(CapabilityError);
    });

    it("denies ipam.release the same structural way", async () => {
      const { dispatch, store, bundlesDir } = freshDispatcher();
      trustAsType(store, bundlesDir, "dns-namecheap", ["dns-provider"]);
      await expect(
        dispatch({ invocationId: "i1", pluginId: "dns-namecheap", method: "ipam.release", args: { ip: "192.168.1.242" } }),
      ).rejects.toThrow(CapabilityError);
    });

    it("surfaces exhaustion as a CapabilityError-shaped rejection, not an uncaught internal error", async () => {
      const { dispatch, store, bundlesDir } = freshDispatcher();
      trustAsType(store, bundlesDir, "network-macvlan", ["network-provider"]);
      store.setIpamRange({ id: "tiny", cidr: "10.0.0.0/30", gateway: "10.0.0.1" });
      await dispatch({ invocationId: "i1", pluginId: "network-macvlan", method: "ipam.allocate", args: { rangeId: "tiny" } });

      await expect(
        dispatch({ invocationId: "i2", pluginId: "network-macvlan", method: "ipam.allocate", args: { rangeId: "tiny" } }),
      ).rejects.toThrow(/no free addresses/);
    });
  });

  describe("net.probeNetwork (T5.2)", () => {
    it("forwards to the injected probeNetwork for a trusted network-provider plugin, and returns its result verbatim", async () => {
      const { dispatch, store, bundlesDir } = freshDispatcher({
        probeNetwork: async (mode, parent) => {
          expect(mode).toBe("macvlan");
          expect(parent).toBe("eth0");
          return { ok: true };
        },
      });
      trustAsType(store, bundlesDir, "network-macvlan", ["network-provider"]);

      const res = await dispatch({ invocationId: "i1", pluginId: "network-macvlan", method: "net.probeNetwork", args: { mode: "macvlan", parent: "eth0" } });
      expect(res).toEqual({ ok: true });
    });

    it("passes a decline reason through unchanged", async () => {
      const { dispatch, store, bundlesDir } = freshDispatcher({
        probeNetwork: async () => ({ ok: false, reason: "daemon says no" }),
      });
      trustAsType(store, bundlesDir, "network-macvlan", ["network-provider"]);

      const res = await dispatch({ invocationId: "i1", pluginId: "network-macvlan", method: "net.probeNetwork", args: { mode: "macvlan", parent: "eth0" } });
      expect(res).toEqual({ ok: false, reason: "daemon says no" });
    });

    it("denies a plugin that isn't a trusted network-provider type", async () => {
      const { dispatch, store, bundlesDir } = freshDispatcher({ probeNetwork: async () => ({ ok: true }) });
      trustAsType(store, bundlesDir, "dns-namecheap", ["dns-provider"]);

      await expect(
        dispatch({ invocationId: "i1", pluginId: "dns-namecheap", method: "net.probeNetwork", args: { mode: "macvlan", parent: "eth0" } }),
      ).rejects.toThrow(CapabilityError);
    });

    it("returns a graceful decline (not a crash) when no probeNetwork implementation was ever injected", async () => {
      const { dispatch, store, bundlesDir } = freshDispatcher();
      trustAsType(store, bundlesDir, "network-macvlan", ["network-provider"]);

      const res = await dispatch({ invocationId: "i1", pluginId: "network-macvlan", method: "net.probeNetwork", args: { mode: "macvlan", parent: "eth0" } });
      expect(res).toEqual({ ok: false, reason: "network probing is unavailable in this environment" });
    });
  });
});
