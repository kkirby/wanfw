import "server-only";
import { createWriteStream } from "node:fs";
import { mkdir, unlink, rm, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { hashBundleDir } from "@wanfw/core-schemas";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB hard cap per spec §10.3

export class UploadTooLargeError extends Error {}
export class InvalidBundleError extends Error {}

function extractTar(tarPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", tarPath, "-C", destDir]);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new InvalidBundleError(`tar exited with code ${code}`))));
  });
}

export interface StreamUploadResult {
  sha256: string;
  bytes: number;
  path: string;
}

/**
 * Streams a plugin bundle tar into stagingDir: writes to a temp file while
 * enforcing maxBytes during the stream (never buffers the whole upload in
 * memory), extracts it, and hashes the resulting directory tree with the
 * same `hashBundleDir` the trust flow verifies against -- so the hash
 * reported here is exactly the hash `wanfwctl plugin trust` expects.
 */
export async function streamUploadToStaging(
  body: ReadableStream<Uint8Array>,
  stagingDir: string,
  maxBytes: number = MAX_UPLOAD_BYTES,
): Promise<StreamUploadResult> {
  await mkdir(stagingDir, { recursive: true });
  const uploadId = randomUUID();
  const tarPath = `${stagingDir}/.upload-${uploadId}.tar`;
  let bytesWritten = 0;

  const writeStream = createWriteStream(tarPath, { mode: 0o600 });

  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesWritten += value.byteLength;
      if (bytesWritten > maxBytes) {
        writeStream.destroy();
        await unlink(tarPath).catch(() => {});
        throw new UploadTooLargeError(`bundle exceeds ${maxBytes} bytes`);
      }
      const ok = writeStream.write(value);
      if (!ok) {
        await new Promise<void>((resolve) => writeStream.once("drain", resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    await unlink(tarPath).catch(() => {});
    throw err;
  }

  const extractDir = `${stagingDir}/.extracting-${uploadId}`;
  await mkdir(extractDir, { recursive: true });
  try {
    await extractTar(tarPath, extractDir);
  } catch (err) {
    await unlink(tarPath).catch(() => {});
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await unlink(tarPath).catch(() => {});

  const sha256 = await hashBundleDir(extractDir);
  const destDir = `${stagingDir}/upload-${sha256}`;
  await rm(destDir, { recursive: true, force: true }).catch(() => {});
  await rename(extractDir, destDir);

  return { sha256, bytes: bytesWritten, path: destDir };
}
