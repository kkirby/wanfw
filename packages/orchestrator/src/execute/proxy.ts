import { join } from "node:path";
import { atomicWriteFile } from "@wanfw/core-schemas";
import type { DockerClient } from "./docker-client.js";

const MANAGED_PROXY_CONTAINER = "wanfw-proxy";

/**
 * write proxy config (§7 EXECUTE step, atomic into wanfw_proxycfg) + reload
 * via `docker exec wanfw-proxy caddy reload ...` -- a docker.exec held by
 * core on behalf of the proxy-engine flow, scoped to the one managed proxy
 * container (never a general-purpose exec capability).
 */
export async function writeProxyConfigAndReload(
  docker: DockerClient,
  proxycfgDir: string,
  filename: string,
  content: string,
  reloadCmd: string[],
): Promise<{ wrote: boolean; reloaded: boolean; output: string }> {
  await atomicWriteFile(join(proxycfgDir, filename), content);
  const result = await docker.exec(MANAGED_PROXY_CONTAINER, reloadCmd);
  if (result.exitCode !== 0) {
    throw new Error(`proxy reload failed (exit ${result.exitCode}): ${result.output}`);
  }
  return { wrote: true, reloaded: true, output: result.output };
}

export { MANAGED_PROXY_CONTAINER };
