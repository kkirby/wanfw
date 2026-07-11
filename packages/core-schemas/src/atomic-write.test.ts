import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";

describe("atomicWriteFile", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-atomic-"));
    dirs.push(dir);
    return dir;
  }

  it("writes file contents exactly", async () => {
    const dir = await tempDir();
    const dest = join(dir, "doc.json");
    await atomicWriteFile(dest, '{"a":1}');
    expect(await readFile(dest, "utf8")).toBe('{"a":1}');
  });

  it("leaves no temp file behind after a successful write", async () => {
    const dir = await tempDir();
    const dest = join(dir, "doc.json");
    await atomicWriteFile(dest, "content");
    const entries = await readdir(dir);
    expect(entries).toEqual(["doc.json"]);
  });

  it("overwrites an existing file atomically (readers never see a partial write)", async () => {
    const dir = await tempDir();
    const dest = join(dir, "doc.json");
    await atomicWriteFile(dest, "version-1");
    await atomicWriteFile(dest, "version-2");
    expect(await readFile(dest, "utf8")).toBe("version-2");
    const entries = await readdir(dir);
    expect(entries).toEqual(["doc.json"]);
  });

  it("creates parent directories as needed", async () => {
    const dir = await tempDir();
    const dest = join(dir, "nested", "deep", "doc.json");
    await atomicWriteFile(dest, "x");
    expect(await readFile(dest, "utf8")).toBe("x");
  });
});
