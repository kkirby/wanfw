import type { DeployPlanInput, DeployPlanOutput } from "@wanfw/plugin-sdk";
import type { HostApiClient } from "@wanfw/plugin-sdk";

/**
 * The deploy anchor shape this plugin's configSchema (../schemas/config-schema.json)
 * accepts, mounted at `spec.deploy` in the composed schema (§5.4/§5.5).
 * Named volumes use a short `name`, not a full Docker volume name -- `plan`
 * namespaces it to `wanfw_<serviceId>_<name>` so the orchestrator's VALIDATE
 * stage's structural `wanfw_<serviceId>*` confinement check (§12.1, baseline,
 * no grant needed) passes without the plugin author having to know that
 * convention. Every other field maps close to 1:1 onto ContainerSpec
 * (§12.1's field table) -- ADR-4 "nothing is inexpressible": this plugin is
 * purely declarative and makes zero imperative Docker calls itself.
 */
export interface DeployDockerConfig {
  plugin: string;
  image: string;
  cmd?: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  mounts?: Array<
    | { type: "volume"; name: string; target: string; readOnly?: boolean }
    | { type: "bind"; source: string; target: string; readOnly?: boolean }
  >;
  devices?: string[];
  networkMode?: "host" | string;
  ports?: number[];
  capAdd?: string[];
  privileged?: boolean;
  securityOpt?: string[];
  user?: string;
  readOnly?: boolean;
  resources?: { memory?: string; cpus?: string };
  labels?: Record<string, string>;
  restart?: string;
}

function namespacedVolumeName(serviceId: string, name: string): string {
  return `wanfw_${serviceId}_${name}`;
}

export async function planTask(input: DeployPlanInput, _host: HostApiClient): Promise<DeployPlanOutput> {
  const serviceId = input.context.serviceId as string;
  const deploy = (input.service.deploy as unknown as DeployDockerConfig) ?? (input.service as unknown as DeployDockerConfig);

  const mounts = (deploy.mounts ?? []).map((m) =>
    m.type === "volume"
      ? { type: "volume" as const, source: namespacedVolumeName(serviceId, m.name), target: m.target, readOnly: m.readOnly }
      : { type: "bind" as const, source: m.source, target: m.target, readOnly: m.readOnly },
  );

  return {
    image: deploy.image,
    ...(deploy.cmd ? { cmd: deploy.cmd } : {}),
    ...(deploy.entrypoint ? { entrypoint: deploy.entrypoint } : {}),
    ...(deploy.env ? { env: deploy.env } : {}),
    ...(mounts.length > 0 ? { mounts } : {}),
    ...(deploy.devices ? { devices: deploy.devices } : {}),
    ...(deploy.networkMode ? { networkMode: deploy.networkMode } : {}),
    ...(deploy.ports ? { ports: deploy.ports } : {}),
    ...(deploy.capAdd ? { capAdd: deploy.capAdd } : {}),
    ...(deploy.privileged !== undefined ? { privileged: deploy.privileged } : {}),
    ...(deploy.securityOpt ? { securityOpt: deploy.securityOpt } : {}),
    ...(deploy.user ? { user: deploy.user } : {}),
    ...(deploy.readOnly !== undefined ? { readOnly: deploy.readOnly } : {}),
    ...(deploy.resources ? { resources: deploy.resources } : {}),
    ...(deploy.labels ? { labels: deploy.labels } : {}),
    ...(deploy.restart ? { restart: deploy.restart } : {}),
  } as unknown as DeployPlanOutput;
}
