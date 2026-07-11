import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { hashBundleDir, loadManifest, type Manifest } from "@wanfw/core-schemas";

export interface StagedBundle {
  /** The staging subdirectory name -- not necessarily the manifest id until validated. */
  dirName: string;
  bundleDir: string;
  sha256: string;
  manifest?: Manifest;
  manifestErrors?: string[];
}

/** Hashes and validates every bundle currently sitting in wanfw_staging (on demand, per spec T2.5). */
export async function listStagedBundles(stagingDir: string): Promise<StagedBundle[]> {
  const entries = await readdir(stagingDir, { withFileTypes: true }).catch(() => []);
  const results: StagedBundle[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bundleDir = join(stagingDir, entry.name);
    const sha256 = await hashBundleDir(bundleDir);
    const loaded = await loadManifest(bundleDir);
    results.push({
      dirName: entry.name,
      bundleDir,
      sha256,
      manifest: loaded.manifest,
      manifestErrors: loaded.valid ? undefined : loaded.errors,
    });
  }

  return results;
}

export async function findStagedBundle(
  stagingDir: string,
  id: string,
  sha256: string,
): Promise<StagedBundle | undefined> {
  const staged = await listStagedBundles(stagingDir);
  return staged.find((b) => b.manifest?.id === id && b.sha256 === sha256);
}
