import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeartbeat, type HeartbeatState } from "./heartbeat.js";

describe("startHeartbeat", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("writes framework.json immediately on start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-heartbeat-"));
    dirs.push(dir);
    const state: HeartbeatState = { current: { phase: "pending-init", ts: "x", version: "0.1.0" } };
    const heartbeat = startHeartbeat(dir, state, 10_000);
    await new Promise((r) => setTimeout(r, 50));
    heartbeat.stop();

    const written = JSON.parse(await readFile(join(dir, "framework.json"), "utf8"));
    expect(written.phase).toBe("pending-init");
    expect(written.version).toBe("0.1.0");
  });

  it("updates the timestamp on each tick", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-heartbeat-"));
    dirs.push(dir);
    const state: HeartbeatState = { current: { phase: "pending-init", ts: "x", version: "0.1.0" } };
    const heartbeat = startHeartbeat(dir, state, 20);
    await new Promise((r) => setTimeout(r, 30));
    const firstTs = state.current.ts;
    await new Promise((r) => setTimeout(r, 40));
    heartbeat.stop();
    expect(state.current.ts).not.toBe("x");
    expect(state.current.ts >= firstTs).toBe(true);
  });

  it("stop() halts further ticks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-heartbeat-"));
    dirs.push(dir);
    const state: HeartbeatState = { current: { phase: "pending-init", ts: "x", version: "0.1.0" } };
    const heartbeat = startHeartbeat(dir, state, 10);
    await new Promise((r) => setTimeout(r, 30));
    heartbeat.stop();
    const tsAfterStop = state.current.ts;
    await new Promise((r) => setTimeout(r, 40));
    expect(state.current.ts).toBe(tsAfterStop);
  });
});
