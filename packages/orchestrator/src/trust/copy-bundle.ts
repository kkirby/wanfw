import { cp, mkdir } from "node:fs/promises";

/** Copies a validated bundle directory into wanfw_bundles/<sha256>/, keyed by hash. */
export async function copyBundleInto(sourceDir: string, bundlesRoot: string, sha256: string): Promise<string> {
  const destDir = `${bundlesRoot}/${sha256}`;
  await mkdir(destDir, { recursive: true });
  await cp(sourceDir, destDir, { recursive: true });
  return destDir;
}
