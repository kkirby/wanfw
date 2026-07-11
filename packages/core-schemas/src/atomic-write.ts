import { randomBytes } from "node:crypto";
import { rename, open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Atomic write: write to a temp file in the same directory, fsync, rename(2)
 * over the destination, then fsync the containing directory. Same-directory
 * temp file guarantees rename is same-filesystem (POSIX atomic rename).
 */
export async function atomicWriteFile(
  destPath: string,
  data: string | Buffer,
  options?: { mode?: number },
): Promise<void> {
  const dir = dirname(destPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${destPath}.tmp-${randomBytes(6).toString("hex")}`;

  const fh = await open(tmpPath, "w", options?.mode ?? 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }

  await rename(tmpPath, destPath);

  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } catch {
    // Some platforms/filesystems (notably macOS on certain volumes) reject
    // fsync on directory file descriptors. The rename itself is still atomic;
    // this is best-effort durability, not a correctness requirement.
  } finally {
    await dirHandle.close();
  }
}
