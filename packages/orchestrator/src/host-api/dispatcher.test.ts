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
    const store = new StateStore(join(dir, "state.sqlite3"));
    stores.push(store);
    const dispatch = buildHostApiDispatcher(store, createLogger("test"));
    return { dispatch, store };
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
});
