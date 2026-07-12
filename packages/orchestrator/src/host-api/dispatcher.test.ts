import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state-store/store.js";
import { createLogger } from "../logger.js";
import { buildHostApiDispatcher, CapabilityError } from "./dispatcher.js";

describe("buildHostApiDispatcher", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function freshDispatcher() {
    const dir = mkdtempSync(join(tmpdir(), "wanfw-hostapi-"));
    dirs.push(dir);
    const secretsDir = mkdtempSync(join(tmpdir(), "wanfw-secrets-"));
    dirs.push(secretsDir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    stores.push(store);
    const dispatch = buildHostApiDispatcher(store, createLogger("test"), secretsDir);
    return { dispatch, store, secretsDir };
  }

  function grant(store: StateStore, pluginId: string, cap: string, scope: Record<string, unknown>): void {
    store.insertGrant({ plugin_id: pluginId, cap, scope_json: JSON.stringify(scope), sig: "sig", created_at: new Date().toISOString() });
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
});
