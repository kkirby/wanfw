import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state-store/store.js";
import { resolveDependencies, checkServiceExposeStub, type FrameworkSpec } from "./resolve.js";

describe("resolveDependencies", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rm(d, { recursive: true, force: true }).catch(() => {}));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-depres-"));
    dirs.push(dir);
    return dir;
  }

  async function makeStore(): Promise<StateStore> {
    const dbDir = await tempDir();
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    return store;
  }

  async function trustBundle(
    store: StateStore,
    bundlesDir: string,
    pluginId: string,
    sha256: string,
    manifest: Record<string, unknown>,
  ): Promise<void> {
    store.insertTrustRecord({
      plugin_id: pluginId,
      version: "0.1.0",
      sha256,
      granted_caps_json: "[]",
      sig: "sig",
      created_at: new Date().toISOString(),
    });
    const bundleDir = join(bundlesDir, sha256);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest));
  }

  const baseFramework: FrameworkSpec = {
    deploymentMode: "subdomain",
    roles: {},
  };

  it("succeeds with no role bindings and no dependencies", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    const result = await resolveDependencies(store, bundlesDir, baseFramework);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("reports a missing setting with the exact §6.3-shaped error message", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    // Uses the exact §6.3 example field (deploymentMode) but with a value
    // that isn't "port" -- "port" trips the separate v1.1-unimplemented
    // stub check (tested on its own below) and would make this test
    // ambiguous about which check produced the error.
    await trustBundle(store, bundlesDir, "cert-letsencrypt-dns01", "sha1", {
      id: "cert-letsencrypt-dns01",
      dependencies: { settings: { deploymentMode: "subdomain" } },
    });

    const result = await resolveDependencies(store, bundlesDir, {
      deploymentMode: "future-mode",
      roles: { certIssuer: "cert-letsencrypt-dns01" },
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toMatch(
      /cert-letsencrypt-dns01 requires deploymentMode="subdomain"; current: "future-mode"/,
    );
  });

  it("reports a missing role dependency", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    await trustBundle(store, bundlesDir, "cert-letsencrypt-dns01", "sha1", {
      id: "cert-letsencrypt-dns01",
      dependencies: { roles: ["dnsProvider"] },
    });

    const result = await resolveDependencies(store, bundlesDir, {
      ...baseFramework,
      roles: { certIssuer: "cert-letsencrypt-dns01" },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "role" && e.message.includes("dnsProvider"))).toBe(true);
  });

  it("passes when the required role is bound", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    await trustBundle(store, bundlesDir, "cert-letsencrypt-dns01", "sha1", {
      id: "cert-letsencrypt-dns01",
      dependencies: { roles: ["dnsProvider"] },
    });
    await trustBundle(store, bundlesDir, "dns-namecheap", "sha2", { id: "dns-namecheap" });

    const result = await resolveDependencies(store, bundlesDir, {
      ...baseFramework,
      roles: { certIssuer: "cert-letsencrypt-dns01", dnsProvider: "dns-namecheap" },
    });

    expect(result.ok).toBe(true);
  });

  it("reports a role binding referencing an untrusted plugin id", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    const result = await resolveDependencies(store, bundlesDir, {
      ...baseFramework,
      roles: { networkProvider: "never-trusted" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toMatch(/not currently trusted/);
  });

  it("reports a missing direct plugin dependency", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    await trustBundle(store, bundlesDir, "plugin-a", "sha1", {
      id: "plugin-a",
      dependencies: { plugins: ["plugin-b"] },
    });

    const result = await resolveDependencies(store, bundlesDir, {
      ...baseFramework,
      roles: { networkProvider: "plugin-a" },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "plugin" && e.message.includes("plugin-b"))).toBe(true);
  });

  it("detects a dependency cycle between role-bound plugins", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    await trustBundle(store, bundlesDir, "plugin-a", "sha1", {
      id: "plugin-a",
      dependencies: { plugins: ["plugin-b"] },
    });
    await trustBundle(store, bundlesDir, "plugin-b", "sha2", {
      id: "plugin-b",
      dependencies: { plugins: ["plugin-a"] },
    });

    const result = await resolveDependencies(store, bundlesDir, {
      ...baseFramework,
      roles: { networkProvider: "plugin-a", proxyEngine: "plugin-b" },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "cycle")).toBe(true);
  });

  it("is atomic: a failing dependency anywhere makes the whole resolution fail (ok=false), never partial", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    await trustBundle(store, bundlesDir, "plugin-a", "sha1", { id: "plugin-a" });
    await trustBundle(store, bundlesDir, "plugin-b", "sha2", {
      id: "plugin-b",
      dependencies: { roles: ["missingRole"] },
    });

    const result = await resolveDependencies(store, bundlesDir, {
      ...baseFramework,
      roles: { networkProvider: "plugin-a", proxyEngine: "plugin-b" },
    });

    expect(result.ok).toBe(false);
  });

  it("flags deploymentMode=port as unimplemented at resolve time (v1.1 stub)", async () => {
    const store = await makeStore();
    const bundlesDir = await tempDir();
    const result = await resolveDependencies(store, bundlesDir, { ...baseFramework, deploymentMode: "port" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "unimplemented" && e.message.includes("v1.1"))).toBe(true);
  });
});

describe("checkServiceExposeStub", () => {
  it("flags isolationTier=quarantine as unimplemented (v1.1 stub)", () => {
    const error = checkServiceExposeStub("quarantine");
    expect(error?.kind).toBe("unimplemented");
    expect(error?.message).toMatch(/v1\.1/);
  });

  it("passes isolationTier=standard through with no error", () => {
    expect(checkServiceExposeStub("standard")).toBeUndefined();
  });

  it("passes an undefined isolationTier through with no error", () => {
    expect(checkServiceExposeStub(undefined)).toBeUndefined();
  });
});
