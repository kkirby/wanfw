import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBundleDir } from "@wanfw/core-schemas";
import { StateStore } from "../state-store/store.js";
import { SigningKeyManager } from "../signing-key.js";
import { AuditLog } from "../audit-log.js";
import { listStagedBundles, findStagedBundle } from "./staging.js";
import { trustStagedBundle, trustBuiltin, untrustPlugin, TrustFlowError, type TrustFlowDeps } from "./trust-flow.js";

describe("trust flow", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rm(d, { recursive: true, force: true }).catch(() => {}));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-trust-"));
    dirs.push(dir);
    return dir;
  }

  async function stageBundle(
    stagingDir: string,
    dirName: string,
    manifest: Record<string, unknown>,
  ): Promise<void> {
    const bundleDir = join(stagingDir, dirName);
    await mkdir(join(bundleDir, "dist"), { recursive: true });
    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(bundleDir, "dist", "main.js"), "// fixture\n");
  }

  function baseManifest(overrides: Record<string, unknown> = {}) {
    return {
      manifestVersion: 1,
      id: "deploy-docker",
      version: "0.1.0",
      frameworkApi: "^1.0",
      types: ["deploy"],
      entrypoint: "dist/main.js",
      runtime: "node22",
      capabilities: [
        { cap: "docker.image.pull", scope: { repos: ["*"] }, reason: "pull images" },
        { cap: "docker.device", scope: { paths: ["/dev/dri/*"] }, reason: "hw transcode" },
      ],
      ...overrides,
    };
  }

  async function makeDeps(): Promise<TrustFlowDeps> {
    const stagingDir = await tempDir();
    const bundlesDir = await tempDir();
    const dbDir = await tempDir();
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const signingKey = await SigningKeyManager.loadOrCreate(join(dbDir, "signing.key"));
    const auditLog = new AuditLog(join(dbDir, "audit.jsonl"), () => signingKey);
    return { store, signingKey, auditLog, stagingDir, bundlesDir };
  }

  it("listStagedBundles hashes and validates every staged bundle", async () => {
    const deps = await makeDeps();
    await stageBundle(deps.stagingDir, "b1", baseManifest());
    const staged = await listStagedBundles(deps.stagingDir);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.manifest?.id).toBe("deploy-docker");
    expect(staged[0]!.sha256).toHaveLength(64);
  });

  it("trustStagedBundle records trust + one grant per capability, copies the bundle, and audits", async () => {
    const deps = await makeDeps();
    await stageBundle(deps.stagingDir, "b1", baseManifest());
    const sha256 = await hashBundleDir(join(deps.stagingDir, "b1"));

    const result = await trustStagedBundle(deps, "deploy-docker", sha256);
    expect(result.grantedCaps).toEqual(["docker.image.pull", "docker.device"]);

    const trustRecord = deps.store.getTrustRecord("deploy-docker", "0.1.0");
    expect(trustRecord).toBeDefined();
    expect(deps.store.listGrants("deploy-docker")).toHaveLength(2);

    const auditEntries = deps.auditLog.readAll();
    expect(auditEntries.some((e) => e.type === "plugin.trust")).toBe(true);
  });

  it("trust records and grants are signed and verify under the current key", async () => {
    const deps = await makeDeps();
    await stageBundle(deps.stagingDir, "b1", baseManifest());
    const sha256 = await hashBundleDir(join(deps.stagingDir, "b1"));
    await trustStagedBundle(deps, "deploy-docker", sha256);

    const { canonicalTrustRecordPayload } = await import("../signing-key.js");
    const trustRecord = deps.store.getTrustRecord("deploy-docker", "0.1.0")!;
    const payload = canonicalTrustRecordPayload("deploy-docker", "0.1.0", sha256, trustRecord.granted_caps_json);
    expect(deps.signingKey.verify(payload, trustRecord.sig)).toBe(true);
  });

  it("throws when no staged bundle matches the given id@hash", async () => {
    const deps = await makeDeps();
    await stageBundle(deps.stagingDir, "b1", baseManifest());
    await expect(trustStagedBundle(deps, "deploy-docker", "0".repeat(64))).rejects.toThrow(TrustFlowError);
  });

  it("staging a different bundle after trust changes nothing: the pinned hash no longer matches anything staged", async () => {
    const deps = await makeDeps();
    await stageBundle(deps.stagingDir, "b1", baseManifest());
    const originalHash = await hashBundleDir(join(deps.stagingDir, "b1"));
    await trustStagedBundle(deps, "deploy-docker", originalHash);

    // Operator (or a compromised tier1) overwrites the staged bundle with
    // something else under the same directory name.
    await rm(join(deps.stagingDir, "b1"), { recursive: true, force: true });
    await stageBundle(deps.stagingDir, "b1", baseManifest({ version: "0.2.0" }));

    // The originally-trusted hash no longer resolves to anything staged...
    const stillFindable = await findStagedBundle(deps.stagingDir, "deploy-docker", originalHash);
    expect(stillFindable).toBeUndefined();

    // ...and the live trust record is completely unaffected by the swap.
    const trustRecord = deps.store.getTrustRecord("deploy-docker", "0.1.0");
    expect(trustRecord?.sha256).toBe(originalHash);
  });

  it("upgrade path: trusting a new hash for an existing id produces a capability diff", async () => {
    const deps = await makeDeps();
    await stageBundle(deps.stagingDir, "v1", baseManifest());
    const hashV1 = await hashBundleDir(join(deps.stagingDir, "v1"));
    await trustStagedBundle(deps, "deploy-docker", hashV1);

    await stageBundle(
      deps.stagingDir,
      "v2",
      baseManifest({
        version: "0.2.0",
        capabilities: [
          { cap: "docker.image.pull", scope: { repos: ["*"] }, reason: "pull images" },
          { cap: "docker.privileged", scope: {}, reason: "new powerful ask" },
        ],
      }),
    );
    const hashV2 = await hashBundleDir(join(deps.stagingDir, "v2"));
    const result = await trustStagedBundle(deps, "deploy-docker", hashV2);

    expect(result.upgradeDiff?.added.map((c) => c.cap)).toEqual(["docker.privileged"]);
    expect(result.upgradeDiff?.removed.map((c) => c.cap)).toEqual(["docker.device"]);
  });

  it("untrustPlugin revokes trust and every live grant; subsequent trust queries reflect it", async () => {
    const deps = await makeDeps();
    await stageBundle(deps.stagingDir, "b1", baseManifest());
    const sha256 = await hashBundleDir(join(deps.stagingDir, "b1"));
    await trustStagedBundle(deps, "deploy-docker", sha256);

    untrustPlugin(deps, "deploy-docker");

    expect(deps.store.listTrustRecords()).toHaveLength(0);
    expect(deps.store.listGrants("deploy-docker")).toHaveLength(0);
    expect(deps.auditLog.readAll().some((e) => e.type === "plugin.untrust")).toBe(true);
  });

  it("untrustPlugin throws for a plugin that was never trusted", async () => {
    const deps = await makeDeps();
    expect(() => untrustPlugin(deps, "never-trusted")).toThrow(TrustFlowError);
  });

  it("trustBuiltin materializes streamed bundle bytes and trusts identically to a staged bundle", async () => {
    const deps = await makeDeps();
    const manifest = baseManifest({ id: "network-bridge", version: "0.1.0" });
    const files = [
      { relPath: "manifest.json", contentBase64: Buffer.from(JSON.stringify(manifest)).toString("base64") },
      { relPath: "dist/main.js", contentBase64: Buffer.from("// builtin\n").toString("base64") },
    ];

    const result = await trustBuiltin(deps, {
      id: "network-bridge",
      version: "0.1.0",
      manifest: manifest as never,
      sha256: "builtinhash123",
      files,
    });

    expect(result.grantedCaps).toEqual(["docker.image.pull", "docker.device"]);
    expect(deps.store.getTrustRecord("network-bridge", "0.1.0")?.sha256).toBe("builtinhash123");

    const { readFile } = await import("node:fs/promises");
    const written = await readFile(join(deps.bundlesDir, "builtinhash123", "manifest.json"), "utf8");
    expect(JSON.parse(written)).toEqual(manifest);
  });
});
