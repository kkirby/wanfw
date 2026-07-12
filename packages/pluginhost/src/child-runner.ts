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

/**
 * Non-secret endpoint-override config, explicitly allowlisted for
 * passthrough into every spawned child's otherwise-clean env (ADR-3: no
 * ambient host secrets/config leak to children by default). Every one of
 * these overrides an ACME/DNS *endpoint URL*, never a credential --
 * credentials only ever reach a plugin via `secrets.get`, never env, and
 * that invariant is unaffected by this list. Exists solely so T4.7's
 * Pebble e2e harness can point cert-letsencrypt-dns01/dns-mock at Pebble
 * and pebble-challtestsrv instead of production endpoints, by setting
 * these on the pluginhost container itself (`docker-compose.pebble.yml`);
 * in the real production compose file none of these are set, so this
 * passthrough is a no-op there.
 */
const ENV_PASSTHROUGH_ALLOWLIST = [
  "WANFW_ACME_DIRECTORY_URL",
  "WANFW_DNS01_RESOLVER",
  "WANFW_CHALLTESTSRV_URL",
  "NODE_TLS_REJECT_UNAUTHORIZED",
] as const;

export function childEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
  for (const key of ENV_PASSTHROUGH_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
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
    // (process.execPath) regardless, so PATH isn't load-bearing there. The
    // only additions are the explicit non-secret endpoint-override
    // allowlist above (empty in production).
    env: childEnv(),
    uid: deps.runAsUid,
    gid: deps.runAsGid,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Nothing else reads child.stderr; an uncaught exception/rejection in a
  // plugin's entrypoint (a real thing that happens -- e.g. T4.2's
  // dns-namecheap plugin hit one live) would otherwise vanish entirely,
  // leaving only "connection closed" upstream with zero clue why. Prefixed
  // so it's greppable in the pluginhost container's own log stream.
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[plugin:${job.pluginId} stderr] ${chunk.toString()}`);
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
