import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBundleDir, bundleExists } from "./bundle-hash.js";

describe("hashBundleDir", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeBundle(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-bundle-"));
    dirs.push(dir);
    for (const [relPath, contents] of Object.entries(files)) {
      const full = join(dir, relPath);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, contents);
    }
    return dir;
  }

  it("is deterministic for the same contents", async () => {
    const dirA = await makeBundle({ "manifest.json": '{"id":"x"}', "dist/main.js": "console.log(1)" });
    const dirB = await makeBundle({ "manifest.json": '{"id":"x"}', "dist/main.js": "console.log(1)" });
    expect(await hashBundleDir(dirA)).toBe(await hashBundleDir(dirB));
  });

  it("changes when a byte changes anywhere in the tree", async () => {
    const dirA = await makeBundle({ "manifest.json": '{"id":"x"}', "dist/main.js": "console.log(1)" });
    const dirB = await makeBundle({ "manifest.json": '{"id":"x"}', "dist/main.js": "console.log(2)" });
    expect(await hashBundleDir(dirA)).not.toBe(await hashBundleDir(dirB));
  });

  it("changes when a file is renamed even with identical total content", async () => {
    const dirA = await makeBundle({ a: "same-content" });
    const dirB = await makeBundle({ b: "same-content" });
    expect(await hashBundleDir(dirA)).not.toBe(await hashBundleDir(dirB));
  });

  it("is independent of directory listing order (sorted internally)", async () => {
    const dirA = await makeBundle({ "z-file": "1", "a-file": "2" });
    const dirB = await makeBundle({ "a-file": "2", "z-file": "1" });
    expect(await hashBundleDir(dirA)).toBe(await hashBundleDir(dirB));
  });

  it("bundleExists distinguishes a real directory from a missing path", async () => {
    const dir = await makeBundle({ "manifest.json": "{}" });
    expect(await bundleExists(dir)).toBe(true);
    expect(await bundleExists(join(dir, "nope"))).toBe(false);
  });
});
