import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state-store/store.js";
import { SigningKeyManager } from "../signing-key.js";
import { AuditLog } from "../audit-log.js";
import { invokeTrustedPlugin, type InvokePluginDeps } from "./invoke-plugin.js";
import { TrustFlowError } from "./trust-flow.js";
import type { PluginConnectionHolder } from "../admin-socket.js";

describe("invokeTrustedPlugin", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rm(d, { recursive: true, force: true }).catch(() => {}));
  });

  async function makeDeps(): Promise<{ deps: InvokePluginDeps; holder: PluginConnectionHolder }> {
    const dbDir = await mkdtemp(join(tmpdir(), "wanfw-invoke-"));
    dirs.push(dbDir);
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const signingKey = await SigningKeyManager.loadOrCreate(join(dbDir, "signing.key"));
    const auditLog = new AuditLog(join(dbDir, "audit.jsonl"), () => signingKey);
    const holder: PluginConnectionHolder = {};
    return { deps: { store, auditLog, pluginConnectionHolder: holder, bundlesDir: "/fake/bundles" }, holder };
  }

  it("throws TrustFlowError when the plugin is not trusted", async () => {
    const { deps } = await makeDeps();
    await expect(
      invokeTrustedPlugin(deps, "never-trusted", "echo", {}, { wallMs: 1000, memMb: 256, cpuSeconds: 5 }),
    ).rejects.toThrow(TrustFlowError);
  });

  it("throws when no pluginhost connection is active", async () => {
    const { deps } = await makeDeps();
    deps.store.insertTrustRecord({
      plugin_id: "deploy-docker",
      version: "0.1.0",
      sha256: "abc",
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });
    await expect(
      invokeTrustedPlugin(deps, "deploy-docker", "echo", {}, { wallMs: 1000, memMb: 256, cpuSeconds: 5 }),
    ).rejects.toThrow(/pluginhost unreachable/);
  });

  it("forwards the invoke call with the trusted bundle's hash and dir, and audits it", async () => {
    const { deps, holder } = await makeDeps();
    deps.store.insertTrustRecord({
      plugin_id: "echo-test-fixture",
      version: "0.1.0",
      sha256: "fixturehash",
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });

    let capturedParams: unknown;
    holder.connection = {
      call: async (_method: string, params: unknown) => {
        capturedParams = params;
        return { invocationId: (params as { invocationId: string }).invocationId, ok: true, result: { echoed: true } };
      },
    } as never;

    const result = await invokeTrustedPlugin(deps, "echo-test-fixture", "echo", { hello: "world" }, {
      wallMs: 1000,
      memMb: 256,
      cpuSeconds: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ echoed: true });
    expect(capturedParams).toMatchObject({
      pluginId: "echo-test-fixture",
      bundleHash: "fixturehash",
      bundleDir: "/fake/bundles/fixturehash",
      task: "echo",
      input: { hello: "world" },
    });

    const entries = deps.auditLog.readAll();
    expect(entries.some((e) => e.type === "plugin.invoke")).toBe(true);
  });

  it("audits plugin.invoke.refused when the connection rejects with a hash mismatch", async () => {
    const { deps, holder } = await makeDeps();
    deps.store.insertTrustRecord({
      plugin_id: "echo-test-fixture",
      version: "0.1.0",
      sha256: "fixturehash",
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });

    holder.connection = {
      call: async () => {
        throw new Error("bundle hash mismatch for echo-test-fixture: expected fixturehash, got tamperedhash");
      },
    } as never;

    await expect(
      invokeTrustedPlugin(deps, "echo-test-fixture", "echo", {}, { wallMs: 1000, memMb: 256, cpuSeconds: 5 }),
    ).rejects.toThrow(/hash mismatch/);

    const entries = deps.auditLog.readAll();
    const refused = entries.find((e) => e.type === "plugin.invoke.refused");
    expect(refused).toBeDefined();
    expect(refused!.checkpointSig).toBeTruthy(); // security-relevant type always checkpointed
  });
});
