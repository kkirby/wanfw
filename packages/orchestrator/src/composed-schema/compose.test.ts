import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state-store/store.js";
import { buildComposedSchema, publishComposedSchema } from "./compose.js";

describe("buildComposedSchema", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rm(d, { recursive: true, force: true }).catch(() => {}));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-composed-"));
    dirs.push(dir);
    return dir;
  }

  async function makeStore(): Promise<StateStore> {
    const dbDir = await tempDir();
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    return store;
  }

  async function makeTrustedBundle(
    bundlesDir: string,
    sha256: string,
    manifest: Record<string, unknown>,
    configSchema?: Record<string, unknown>,
  ): Promise<void> {
    const bundleDir = join(bundlesDir, sha256);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest));
    if (configSchema) {
      await writeFile(join(bundleDir, "config.schema.json"), JSON.stringify(configSchema));
    }
  }

  it("returns the bare core schemas when no plugins are trusted", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    const composed = await buildComposedSchema(store, bundlesDir);
    expect(composed.boundDeployPluginId).toBeUndefined();
    expect(composed.pluginConfigSchemas).toEqual({});
  });

  it("mounts a trusted deploy-type plugin's configSchema at spec.deploy", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    const sha256 = "abc123";

    store.insertTrustRecord({
      plugin_id: "deploy-docker",
      version: "0.1.0",
      sha256,
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });
    await makeTrustedBundle(
      bundlesDir,
      sha256,
      { id: "deploy-docker", types: ["deploy"], configSchema: "config.schema.json" },
      { type: "object", properties: { image: { type: "string" }, env: { type: "object" } } },
    );

    const composed = await buildComposedSchema(store, bundlesDir);
    expect(composed.boundDeployPluginId).toBe("deploy-docker");
    const deployAnchor = (composed.service as { properties: { deploy: { properties: Record<string, unknown> } } })
      .properties.deploy.properties;
    expect(deployAnchor.image).toEqual({ type: "string" });
    expect(deployAnchor.plugin).toEqual({ type: "string" });
  });

  it("mounts a non-deploy plugin's configSchema at its own plugins/<id> anchor, not spec.deploy", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    const sha256 = "def456";

    store.insertTrustRecord({
      plugin_id: "dns-namecheap",
      version: "0.1.0",
      sha256,
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });
    await makeTrustedBundle(
      bundlesDir,
      sha256,
      { id: "dns-namecheap", types: ["dns-provider"], configSchema: "config.schema.json" },
      { type: "object", properties: { apiKey: { type: "string" } } },
    );

    const composed = await buildComposedSchema(store, bundlesDir);
    expect(composed.boundDeployPluginId).toBeUndefined();
    expect(composed.pluginConfigSchemas["dns-namecheap"]).toEqual({
      type: "object",
      properties: { apiKey: { type: "string" } },
    });
  });

  it("picks the lowest plugin id deterministically when multiple deploy-type plugins are trusted", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();

    store.insertTrustRecord({
      plugin_id: "zzz-deploy",
      version: "0.1.0",
      sha256: "hash1",
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });
    await makeTrustedBundle(bundlesDir, "hash1", { id: "zzz-deploy", types: ["deploy"], configSchema: "config.schema.json" }, {
      type: "object",
      properties: {},
    });

    store.insertTrustRecord({
      plugin_id: "aaa-deploy",
      version: "0.1.0",
      sha256: "hash2",
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });
    await makeTrustedBundle(bundlesDir, "hash2", { id: "aaa-deploy", types: ["deploy"], configSchema: "config.schema.json" }, {
      type: "object",
      properties: {},
    });

    const composed = await buildComposedSchema(store, bundlesDir);
    expect(composed.boundDeployPluginId).toBe("aaa-deploy");
  });

  it("ignores a revoked (untrusted) plugin", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    const sha256 = "revokedhash";

    store.insertTrustRecord({
      plugin_id: "deploy-docker",
      version: "0.1.0",
      sha256,
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });
    store.revokeTrustRecord("deploy-docker", "0.1.0");
    await makeTrustedBundle(bundlesDir, sha256, { id: "deploy-docker", types: ["deploy"], configSchema: "config.schema.json" }, {
      type: "object",
      properties: {},
    });

    const composed = await buildComposedSchema(store, bundlesDir);
    expect(composed.boundDeployPluginId).toBeUndefined();
  });

  it("publishComposedSchema atomically writes wanfw_status/schema.json", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    const statusDir = await tempDir();

    await publishComposedSchema(store, bundlesDir, statusDir);

    const { readFile } = await import("node:fs/promises");
    const written = JSON.parse(await readFile(join(statusDir, "schema.json"), "utf8"));
    expect(written.envelope).toBeDefined();
    expect(written.service).toBeDefined();
  });
});
