import { describe, expect, it, vi, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hashBundleDir } from "@wanfw/core-schemas";
import { runInvocation, buildSpawnCommand, childEnv, HashMismatchError, type InvocationJob, type SpawnFn } from "./child-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "__fixtures__");

// V8 reserves a large virtual address range (CodeRange, heap arenas) at
// startup regardless of actual heap usage -- on Linux, `prlimit --as` below
// that floor crashes *any* Node child (SharedHeapDeserializer OOM),
// including an entirely innocent one, before it can do anything. The floor
// varies by Node/V8 build: 768MB was enough locally but GitHub Actions'
// ubuntu-latest Node 22 build needs more -- 1536MB is comfortably above
// what's been observed there. The rlimit-enforcement test deliberately
// sets a limit *under* the floor to prove the limit is real.
const SAFE_MEM_MB = 1536;

function baseJob(overrides: Partial<InvocationJob> = {}): InvocationJob {
  return {
    invocationId: "inv-1",
    pluginId: "echo-test-fixture",
    bundleHash: "will-be-overwritten",
    bundleDir: join(fixturesDir, "echo-plugin"),
    task: "echo",
    input: { hello: "world" },
    limits: { wallMs: 2000, memMb: SAFE_MEM_MB, cpuSeconds: 5 },
    ...overrides,
  };
}

async function realHash(dir: string): Promise<string> {
  return hashBundleDir(dir);
}

const noopHostApi = async () => ({});

describe("runInvocation: happy path", () => {
  it("spawns the child, bridges NDJSON, and resolves with the task result", async () => {
    const bundleDir = join(fixturesDir, "echo-plugin");
    const bundleHash = await realHash(bundleDir);
    const job = baseJob({ bundleDir, bundleHash });

    const result = await runInvocation(job, { hostApiHandler: noopHostApi });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ hello: "world" });
    expect(result.invocationId).toBe("inv-1");
  });
});

describe("runInvocation: hash mismatch refused before spawn", () => {
  it("throws HashMismatchError and never calls spawnFn", async () => {
    const bundleDir = join(fixturesDir, "echo-plugin");
    const job = baseJob({ bundleDir, bundleHash: "0000000000000000000000000000000000000000000000000000000000000000" });
    const spawnFn = vi.fn<SpawnFn>(spawn);

    await expect(runInvocation(job, { hostApiHandler: noopHostApi, spawnFn })).rejects.toThrow(HashMismatchError);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("runInvocation: timeout kill", () => {
  it("kills the child and returns a timeout error when wallMs elapses with no response", async () => {
    const bundleDir = join(fixturesDir, "sleep-plugin");
    const bundleHash = await realHash(bundleDir);
    const job = baseJob({
      bundleDir,
      bundleHash,
      task: "never-responds",
      limits: { wallMs: 300, memMb: SAFE_MEM_MB, cpuSeconds: 5 },
    });

    const start = Date.now();
    const result = await runInvocation(job, { hostApiHandler: noopHostApi });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("timeout");
    expect(elapsed).toBeLessThan(2000);
  }, 5000);
});

describe("runInvocation: stderr tail on a crashing child", () => {
  it("folds the child's stderr output into the nonzero_exit error message", async () => {
    const bundleDir = join(fixturesDir, "crash-plugin");
    const bundleHash = await realHash(bundleDir);
    const job = baseJob({ bundleDir, bundleHash, task: "anything" });

    const result = await runInvocation(job, { hostApiHandler: noopHostApi });

    expect(result.ok).toBe(false);
    // Which failure mode wins is a race (the connection rejecting on the
    // closed pipe vs. the child's own "exit" event) -- same nondeterminism
    // already documented/asserted-around in the rlimit-enforcement test
    // below. Either way the stderr tail must be present.
    expect(["nonzero_exit", "invoke_error"]).toContain(result.error?.code);
    expect(result.error?.message).toContain("simulated plugin crash for stderr-tail test");
  });

  it("truncates an oversized stderr tail rather than growing the message unboundedly", async () => {
    const bundleDir = join(fixturesDir, "crash-plugin");
    const bundleHash = await realHash(bundleDir);
    const job = baseJob({ bundleDir, bundleHash, task: "anything" });
    // A fake spawn whose child writes far more than the 4KB tail cap before exiting.
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const spawnFn = vi.fn(() => {
      const child: any = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      setImmediate(() => {
        child.stderr.write("x".repeat(10_000));
        child.emit("exit", 1);
      });
      return child;
    });

    const result = await runInvocation(job, { hostApiHandler: noopHostApi, spawnFn: spawnFn as any });

    expect(result.ok).toBe(false);
    expect(result.error?.message.length).toBeLessThan(10_000);
  });
});

describe("childEnv: non-secret endpoint-override passthrough (T4.7)", () => {
  const ALLOWED = ["WANFW_ACME_DIRECTORY_URL", "WANFW_DNS01_RESOLVER", "WANFW_CHALLTESTSRV_URL", "NODE_TLS_REJECT_UNAUTHORIZED"] as const;

  afterEach(() => {
    for (const key of ALLOWED) delete process.env[key];
    delete process.env.WANFW_SOME_SECRET;
  });

  it("is just PATH when none of the allowlisted vars are set on the pluginhost process", () => {
    expect(childEnv()).toEqual({ PATH: "/usr/bin:/bin" });
  });

  it("forwards every allowlisted var that is set, verbatim", () => {
    process.env.WANFW_ACME_DIRECTORY_URL = "https://pebble:14000/dir";
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    expect(childEnv()).toEqual({
      PATH: "/usr/bin:/bin",
      WANFW_ACME_DIRECTORY_URL: "https://pebble:14000/dir",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    });
  });

  it("never forwards an arbitrary env var outside the allowlist", () => {
    process.env.WANFW_SOME_SECRET = "should-never-leak";
    expect(childEnv()).toEqual({ PATH: "/usr/bin:/bin" });
  });
});

describe("runInvocation: invocation isolation", () => {
  it("two concurrent invokes do not cross streams", async () => {
    const bundleDir = join(fixturesDir, "echo-plugin");
    const bundleHash = await realHash(bundleDir);

    const [resultA, resultB] = await Promise.all([
      runInvocation(baseJob({ bundleDir, bundleHash, invocationId: "a", input: { who: "a" } }), {
        hostApiHandler: noopHostApi,
      }),
      runInvocation(baseJob({ bundleDir, bundleHash, invocationId: "b", input: { who: "b" } }), {
        hostApiHandler: noopHostApi,
      }),
    ]);

    expect(resultA.result).toEqual({ who: "a" });
    expect(resultB.result).toEqual({ who: "b" });
    expect(resultA.invocationId).toBe("a");
    expect(resultB.invocationId).toBe("b");
  });
});

describe("buildSpawnCommand", () => {
  it("wraps with prlimit on linux", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const { command, args } = buildSpawnCommand("/bundle/dist/main.js", { wallMs: 1000, memMb: 128, cpuSeconds: 10 });
      expect(command).toBe("prlimit");
      expect(args).toEqual([
        "--as=134217728",
        "--cpu=10",
        "--nofile=256",
        "--",
        process.execPath,
        "/bundle/dist/main.js",
      ]);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("falls back to a plain node spawn on non-linux (documented dev relaxation)", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { command, args } = buildSpawnCommand("/bundle/dist/main.js", { wallMs: 1000, memMb: 128, cpuSeconds: 10 });
      expect(command).toBe(process.execPath);
      expect(args).toEqual(["/bundle/dist/main.js"]);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });
});

describe("runInvocation: rlimit enforcement (Linux only)", () => {
  it.skipIf(process.platform !== "linux")(
    "a child that tries to balloon memory dies under the memMb limit",
    async () => {
      const bundleDir = join(fixturesDir, "balloon-plugin");
      const bundleHash = await realHash(bundleDir);
      const job = baseJob({
        bundleDir,
        bundleHash,
        task: "balloon",
        limits: { wallMs: 5000, memMb: 32, cpuSeconds: 5 },
      });

      const result = await runInvocation(job, { hostApiHandler: noopHostApi });
      expect(result.ok).toBe(false);
      // Which failure mode wins is a race (immediate exec failure, the
      // child dying before our stdin write lands, or a clean nonzero exit)
      // -- what matters is that the OS-enforced limit reliably kills it.
      expect(["nonzero_exit", "spawn_error", "invoke_error"]).toContain(result.error?.code);
    },
    10000,
  );
});
