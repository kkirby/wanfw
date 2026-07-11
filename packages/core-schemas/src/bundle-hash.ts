import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

async function listFilesSorted(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesSorted(full, base)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort((a, b) => relative(base, a).localeCompare(relative(base, b)));
}

/**
 * Deterministic sha256 over a bundle directory's contents: sorted relative
 * file paths concatenated with their bytes. Same function used at trust
 * time (hash the staged bundle) and at invoke time (verify against the
 * pinned hash) -- they must never drift, so it lives in one place.
 */
export async function hashBundleDir(dir: string): Promise<string> {
  const files = await listFilesSorted(dir);
  const hash = createHash("sha256");
  for (const file of files) {
    const relPath = relative(dir, file);
    const contents = await readFile(file);
    hash.update(relPath, "utf8");
    hash.update("\0");
    hash.update(contents);
  }
  return hash.digest("hex");
}

export async function bundleExists(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}
