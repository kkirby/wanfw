import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchDesiredState, type DesiredStateWatcherHandle } from "./watcher.js";

describe("watchDesiredState", () => {
  const dirs: string[] = [];
  const handles: DesiredStateWatcherHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.stop()));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-watch-"));
    dirs.push(dir);
    return dir;
  }

  it("fires onChange after a file is written, debounced", async () => {
    const dir = await tempDir();
    let calls = 0;
    const handle = watchDesiredState(dir, () => calls++, { debounceMs: 50, pollIntervalMs: 100_000 });
    handles.push(handle);
    await new Promise((r) => setTimeout(r, 100)); // let the watcher settle before writing

    await writeFile(join(dir, "framework.json"), "{}");
    await new Promise((r) => setTimeout(r, 300));

    expect(calls).toBeGreaterThanOrEqual(1);
  }, 5000);

  it("collapses a burst of writes into one debounced call", async () => {
    const dir = await tempDir();
    let calls = 0;
    const handle = watchDesiredState(dir, () => calls++, { debounceMs: 100, pollIntervalMs: 100_000 });
    handles.push(handle);
    await new Promise((r) => setTimeout(r, 100));

    for (let i = 0; i < 5; i++) {
      await writeFile(join(dir, `f${i}.json`), "{}");
    }
    await new Promise((r) => setTimeout(r, 400));

    expect(calls).toBe(1);
  }, 5000);

  it("nudge() triggers onChange even with no filesystem event", async () => {
    const dir = await tempDir();
    let calls = 0;
    const handle = watchDesiredState(dir, () => calls++, { debounceMs: 20, pollIntervalMs: 100_000 });
    handles.push(handle);

    handle.nudge();
    await new Promise((r) => setTimeout(r, 100));

    expect(calls).toBe(1);
  }, 5000);

  it("poll fallback fires onChange even with zero filesystem activity", async () => {
    const dir = await tempDir();
    let calls = 0;
    const handle = watchDesiredState(dir, () => calls++, { debounceMs: 20, pollIntervalMs: 100 });
    handles.push(handle);

    await new Promise((r) => setTimeout(r, 350));

    expect(calls).toBeGreaterThanOrEqual(2);
  }, 5000);
});
