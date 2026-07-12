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
  };
}
