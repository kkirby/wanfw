import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { hashBundleDir } from "@wanfw/core-schemas";
import { JsonRpcConnection, type MethodHandler } from "./jsonrpc.js";

/**
 * Narrow function shape actually used here (one specific overload of the
 * real `spawn`), rather than `typeof spawn`'s full overload set -- the
 * overloaded type is needlessly awkward to satisfy with a test spy.
 */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface InvocationLimits {
  wallMs: number;
  memMb: number;
  cpuSeconds: number;
}

export interface InvocationJob {
  invocationId: string;
  pluginId: string;
  bundleHash: string;
  bundleDir: string;
  task: string;
  input: unknown;
  limits: InvocationLimits;
}

export interface InvocationResult {
  invocationId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ChildRunnerDeps {
  /** Host API dispatcher: handles calls the child makes (host.*). Tagged with invocationId by the caller. */
  hostApiHandler: MethodHandler;
  /** Overridable for tests: defaults to real hashBundleDir. */
  hashBundleDirFn?: (dir: string) => Promise<string>;
  /** Overridable for tests: defaults to node:child_process.spawn. */
  spawnFn?: SpawnFn;
  /** uid/gid to drop to; omitted (undefined) when not running as root (dev/test). */
  runAsUid?: number;
  runAsGid?: number;
}

/**
 * Builds the argv wrapper for resource limits (spec §6.5 / ADR-3). `prlimit`
 * is Linux-only (util-linux); on non-Linux dev machines we fall back to an
 * unwrapped spawn so local development and macOS test runs still work --
 * documented relaxation, not a silent security downgrade: the real
 * enforcement is expected from the Linux container this ships in.
 */
export function buildSpawnCommand(
  entrypointAbsPath: string,
  limits: InvocationLimits,
): { command: string; args: string[] } {
  // process.execPath (an absolute path) rather than the bare "node" command:
  // the child spawns with a clean (empty) env for secrecy, so there is no
  // PATH for execvp to search a bare command name against.
  if (process.platform === "linux") {
    return {
      command: "prlimit",
      args: [
        `--as=${limits.memMb * 1024 * 1024}`,
        `--cpu=${limits.cpuSeconds}`,
        "--nofile=256",
        "--",
        process.execPath,
        entrypointAbsPath,
      ],
    };
  }
  return { command: process.execPath, args: [entrypointAbsPath] };
}

export class HashMismatchError extends Error {}

/** Verifies the bundle hash, spawns one child, bridges NDJSON JSON-RPC, enforces the wall-clock timeout. */
export async function runInvocation(job: InvocationJob, deps: ChildRunnerDeps): Promise<InvocationResult> {
  const hashFn = deps.hashBundleDirFn ?? hashBundleDir;
  const actualHash = await hashFn(job.bundleDir);
  if (actualHash !== job.bundleHash) {
    throw new HashMismatchError(
      `bundle hash mismatch for ${job.pluginId}: expected ${job.bundleHash}, got ${actualHash}`,
    );
  }

  const entrypoint = `${job.bundleDir}/dist/main.js`;
  const { command, args } = buildSpawnCommand(entrypoint, job.limits);
  const spawnFn: SpawnFn = deps.spawnFn ?? spawn;

  const child = spawnFn(command, args, {
    cwd: job.bundleDir,
    // Clean env: no host secrets, no ambient config. PATH is not a secret --
    // it's kept minimal so `prlimit` (the Linux rlimit wrapper) resolves via
    // execvp; the actual node invocation always uses an absolute path
    // (process.execPath) regardless, so PATH isn't load-bearing there.
    env: { PATH: "/usr/bin:/bin" },
    uid: deps.runAsUid,
    gid: deps.runAsGid,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const connection = new JsonRpcConnection(child.stdout, child.stdin);
  connection.registerMethod("host.call", async (params) => deps.hostApiHandler(params));

  return new Promise<InvocationResult>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        invocationId: job.invocationId,
        ok: false,
        error: { code: "timeout", message: `invocation exceeded wallMs=${job.limits.wallMs}` },
      });
    }, job.limits.wallMs);

    connection
      .call(job.task, job.input)
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill();
        resolve({ invocationId: job.invocationId, ok: true, result });
      })
      .catch((err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill();
        resolve({ invocationId: job.invocationId, ok: false, error: { code: "invoke_error", message: err.message } });
      });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        invocationId: job.invocationId,
        ok: false,
        error: { code: "nonzero_exit", message: `child exited with code ${code}` },
      });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ invocationId: job.invocationId, ok: false, error: { code: "spawn_error", message: err.message } });
    });
  });
}
