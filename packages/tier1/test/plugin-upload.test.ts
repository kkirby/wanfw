import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { hashBundleDir } from "@wanfw/core-schemas";
import { streamUploadToStaging, MAX_UPLOAD_BYTES, UploadTooLargeError, InvalidBundleError } from "../lib/plugin-upload";

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream<Uint8Array>;
}

function tarDir(dir: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-cf", outPath, "-C", dir, "."]);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
  });
}

describe("streamUploadToStaging", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeBundleTar(): Promise<{ tarPath: string; sourceDir: string }> {
    const sourceDir = await mkdtemp(join(tmpdir(), "wanfw-upload-src-"));
    dirs.push(sourceDir);
    await mkdir(join(sourceDir, "dist"), { recursive: true });
    await writeFile(join(sourceDir, "manifest.json"), JSON.stringify({ id: "test-plugin", version: "0.1.0" }));
    await writeFile(join(sourceDir, "dist", "main.js"), "console.log(1)\n");

    const tarDir_ = await mkdtemp(join(tmpdir(), "wanfw-upload-tar-"));
    dirs.push(tarDir_);
    const tarPath = join(tarDir_, "bundle.tar");
    await tarDir(sourceDir, tarPath);
    return { tarPath, sourceDir };
  }

  it("streams a tar upload, extracts it, and reports the tree hash matching hashBundleDir", async () => {
    const { tarPath, sourceDir } = await makeBundleTar();
    const stagingDir = await mkdtemp(join(tmpdir(), "wanfw-upload-staging-"));
    dirs.push(stagingDir);

    const stream = toWebStream(createReadStream(tarPath));
    const result = await streamUploadToStaging(stream, stagingDir);

    const expectedHash = await hashBundleDir(sourceDir);
    expect(result.sha256).toBe(expectedHash);
    expect(result.path).toBe(join(stagingDir, `upload-${expectedHash}`));

    const manifest = JSON.parse(await readFile(join(result.path, "manifest.json"), "utf8"));
    expect(manifest).toEqual({ id: "test-plugin", version: "0.1.0" });
  });

  it("leaves no temp files behind after a successful upload", async () => {
    const { tarPath } = await makeBundleTar();
    const stagingDir = await mkdtemp(join(tmpdir(), "wanfw-upload-staging-"));
    dirs.push(stagingDir);

    const stream = toWebStream(createReadStream(tarPath));
    await streamUploadToStaging(stream, stagingDir);

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(stagingDir);
    expect(entries.every((e) => !e.startsWith(".upload-") && !e.startsWith(".extracting-"))).toBe(true);
  });

  it("rejects an upload exceeding the byte cap without buffering the whole thing (streams, does not throw OOM)", async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), "wanfw-upload-staging-"));
    dirs.push(stagingDir);

    // 1KB cap, feed a larger buffer.
    const oversized = Buffer.alloc(4096, 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });

    await expect(streamUploadToStaging(stream, stagingDir, 1024)).rejects.toThrow(UploadTooLargeError);

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(stagingDir);
    expect(entries).toEqual([]); // temp file cleaned up on rejection
  });

  it("rejects a non-tar upload as an invalid bundle and cleans up", async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), "wanfw-upload-staging-"));
    dirs.push(stagingDir);

    const garbage = Buffer.from("this is not a tar file at all, just plain text\n".repeat(10));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(garbage);
        controller.close();
      },
    });

    await expect(streamUploadToStaging(stream, stagingDir)).rejects.toThrow(InvalidBundleError);

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(stagingDir);
    expect(entries).toEqual([]);
  });

  it("default MAX_UPLOAD_BYTES is 50 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });
});
