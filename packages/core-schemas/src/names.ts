/**
 * Single source of truth for the working name. Spec preamble (invariant #15):
 * the working name appears in exactly one constants module.
 */
export const WANFW_NAME = "wanfw";
export const WANFW_CLI_NAME = "wanfwctl";
export const WANFW_CLI_INNER_NAME = "wanfwctl-inner";

export const WANFW_CONTAINER_NAMES = {
  tier1: "wanfw-tier1",
  orchestrator: "wanfw-orchestrator",
  pluginhost: "wanfw-pluginhost",
  proxy: "wanfw-proxy",
} as const;

export const WANFW_LABELS = {
  managed: "wanfw.managed",
  service: "wanfw.service",
  plan: "wanfw.plan",
  confighash: "wanfw.confighash",
} as const;

export const WANFW_SOCKET_PATHS = {
  status: "/run/wanfw/status/orch-status.sock",
  plugin: "/run/wanfw/plugin/orch-plugin.sock",
  admin: "/run/wanfw-admin/admin.sock",
} as const;
