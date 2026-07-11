import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface BundleFile {
  relPath: string;
  contentBase64: string;
}

/** Materializes a built-in's streamed bytes (via pluginhost builtins.read) into wanfw_bundles/<sha256>/. */
export async function writeBundleFiles(bundlesRoot: string, sha256: string, files: BundleFile[]): Promise<string> {
  const destDir = join(bundlesRoot, sha256);
  await mkdir(destDir, { recursive: true });
  for (const file of files) {
    const target = join(destDir, file.relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.contentBase64, "base64"));
  }
  return destDir;
}
