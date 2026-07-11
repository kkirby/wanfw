import type { JsonValue } from "@wanfw/core-schemas";

/**
 * Task IO shapes (spec §6.5, §7). These are intentionally loose (JsonValue
 * payloads) at this stage of the build -- the field-by-field contracts for
 * each task firm up as their owning plugins land (deploy-docker in T3.10,
 * network-bridge in T3.11, proxy-caddy in T3.12, cert/dns in T4.x). The SDK
 * exists now so T2.9's echo plugin (and every later plugin) has a single
 * place these types live and change.
 */

export interface DeployPlanInput {
  service: Record<string, JsonValue>;
  context: Record<string, JsonValue>;
}
export type DeployPlanOutput = Record<string, JsonValue>;

export interface NetworkProbeInput {
  env: Record<string, JsonValue>;
}
export type NetworkProbeOutput = Record<string, JsonValue>;

export interface NetworkPlanInput {
  purpose: "shared-proxy" | "dedicated-proxy";
  ports: number[];
  stableAddress: boolean;
}
export type NetworkPlanOutput = Record<string, JsonValue>;

export interface ProxyRenderInput {
  routes: JsonValue[];
}
export type ProxyRenderOutput = Record<string, JsonValue>;

export interface CertEnsureInput {
  names: string[];
}
export type CertEnsureOutput = Record<string, JsonValue>;

export interface MigrateInput {
  fromVersion: number;
  config: Record<string, JsonValue>;
}
export type MigrateOutput = Record<string, JsonValue>;

export interface ValidateInput {
  config: Record<string, JsonValue>;
}
export interface ValidateOutput {
  valid: boolean;
  errors?: string[];
}

/** Generic task handler shape: every registered task looks like this to the SDK runtime. */
export type TaskHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  host: import("./host-client.js").HostApiClient,
) => Promise<TOutput>;

export type TaskMap = Record<string, TaskHandler>;
