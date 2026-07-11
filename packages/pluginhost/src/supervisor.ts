import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonRpcConnection, type MethodHandler } from "./jsonrpc.js";
import { runInvocation, type InvocationJob, type ChildRunnerDeps } from "./child-runner.js";

export interface BuiltinInfo {
  id: string;
  version: string;
  manifest: unknown;
  sha256: string;
}

export interface SupervisorDeps {
  /** Directory built-in bundles ship in inside the pluginhost image. */
  builtinsDir: string;
  /** How to compute a bundle's hash; injected so tests don't need real files. */
  hashBundleDirFn: (dir: string) => Promise<string>;
  hostApiHandler: MethodHandler;
  runAsUid?: number;
  runAsGid?: number;
}

/**
 * Registers the pluginhost's control-RPC surface on a connection to the
 * orchestrator (interpretation 2 & 4: builtins.list/read, helper.wanIp) and
 * the `invoke` job handler (ADR-3). The pluginhost is a dumb supervisor and
 * pipe: it never enforces capabilities itself, only spawns and bridges.
 */
export function registerSupervisorMethods(connection: JsonRpcConnection, deps: SupervisorDeps): void {
  connection.registerMethod("builtins.list", async () => {
    const entries = await readdir(deps.builtinsDir, { withFileTypes: true }).catch(() => []);
    const builtins: BuiltinInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bundleDir = join(deps.builtinsDir, entry.name);
      try {
        const manifestRaw = await readFile(join(bundleDir, "manifest.json"), "utf8");
        const manifest = JSON.parse(manifestRaw) as { id: string; version: string };
        const sha256 = await deps.hashBundleDirFn(bundleDir);
        builtins.push({ id: manifest.id, version: manifest.version, manifest, sha256 });
      } catch {
        // a malformed built-in directory is skipped, not fatal to listing
      }
    }
    return builtins;
  });

  connection.registerMethod("builtins.read", async (params) => {
    const { id } = params as { id: string };
    const bundleDir = join(deps.builtinsDir, id);
    const manifestRaw = await readFile(join(bundleDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as { version: string };
    const sha256 = await deps.hashBundleDirFn(bundleDir);
    return { id, version: manifest.version, sha256, bundleDir };
  });

  connection.registerMethod("helper.wanIp", async (params) => {
    const { url } = (params as { url?: string }) ?? {};
    const endpoint = url ?? "https://api.ipify.org?format=json";
    const res = await fetch(endpoint);
    const body = (await res.json()) as { ip?: string };
    return { ip: body.ip };
  });

  connection.registerMethod("invoke", async (params) => {
    const job = params as InvocationJob;
    // Every child-originated host API call is tagged with this invocation's
    // id before forwarding upstream: the orchestrator's grant store is
    // authoritative, keyed by (pluginId, invocationId context), never trusting
    // anything the child claims about itself (§6.5).
    const runnerDeps: ChildRunnerDeps = {
      hostApiHandler: (params: unknown) =>
        deps.hostApiHandler({ invocationId: job.invocationId, pluginId: job.pluginId, ...(params as object) }),
      hashBundleDirFn: deps.hashBundleDirFn,
      runAsUid: deps.runAsUid,
      runAsGid: deps.runAsGid,
    };
    return runInvocation(job, runnerDeps);
  });
}
