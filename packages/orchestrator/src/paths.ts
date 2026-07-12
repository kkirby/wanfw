/**
 * Filesystem layout inside the orchestrator container. Overridable via env
 * vars so unit tests can point at a tmp dir instead of the real /data, /run.
 */
export interface OrchestratorPaths {
  dataRoot: string;
  stateDir: string;
  statusDir: string;
  desiredDir: string;
  stagingDir: string;
  bundlesDir: string;
  proxycfgDir: string;
  secretsDir: string;
  certsDir: string;
  statusSocketDir: string;
  pluginSocketDir: string;
  adminSocketDir: string;
  statusSocketPath: string;
  pluginSocketPath: string;
  adminSocketPath: string;
  dockerSocketPath?: string;
  /** Real Docker volume names backing the proxy container's certs/proxycfg mounts (T4.7) -- not derivable from `dataRoot` since these are volumes the orchestrator attaches *other* containers to, not its own mount paths. Compose prefixes every named volume with the project name, so under `docker-compose.yml`'s `name: wanfw` these are `wanfw_wanfw_certs`/`wanfw_wanfw_proxycfg`, not the bare `wanfw_certs`/`wanfw_proxycfg` the volume keys read as. */
  certsVolumeName: string;
  proxycfgVolumeName: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): OrchestratorPaths {
  const dataRoot = env.WANFW_DATA_ROOT ?? "/data";
  const statusSocketDir = env.WANFW_STATUS_SOCKET_DIR ?? "/run/wanfw/status";
  const pluginSocketDir = env.WANFW_PLUGIN_SOCKET_DIR ?? "/run/wanfw/plugin";
  const adminSocketDir = env.WANFW_ADMIN_SOCKET_DIR ?? "/run/wanfw-admin";

  return {
    dataRoot,
    stateDir: `${dataRoot}/state`,
    statusDir: `${dataRoot}/status`,
    desiredDir: `${dataRoot}/desired`,
    stagingDir: `${dataRoot}/staging`,
    bundlesDir: `${dataRoot}/bundles`,
    proxycfgDir: `${dataRoot}/proxycfg`,
    secretsDir: `${dataRoot}/secrets`,
    certsDir: `${dataRoot}/certs`,
    statusSocketDir,
    pluginSocketDir,
    adminSocketDir,
    statusSocketPath: `${statusSocketDir}/orch-status.sock`,
    pluginSocketPath: `${pluginSocketDir}/orch-plugin.sock`,
    adminSocketPath: `${adminSocketDir}/admin.sock`,
    dockerSocketPath: env.WANFW_DOCKER_SOCKET_PATH,
    certsVolumeName: env.WANFW_CERTS_VOLUME_NAME ?? "wanfw_certs",
    proxycfgVolumeName: env.WANFW_PROXYCFG_VOLUME_NAME ?? "wanfw_proxycfg",
  };
}
