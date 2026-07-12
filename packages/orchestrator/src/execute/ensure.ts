import type { ContainerSpec, MountSpec } from "../validate/index.js";
import type { CreateContainerOptions, DockerClient } from "./docker-client.js";
import { computeConfigHash, computeNetworkConfigHash, computeVolumeConfigHash } from "./confighash.js";
import { MANAGED_LABEL } from "./docker-client.js";

export interface StepResult {
  step: string;
  changed: boolean;
  detail: string;
}

function baseLabels(extra: Record<string, string>): Record<string, string> {
  return { [MANAGED_LABEL]: "true", ...extra };
}

/** ensureNetwork (§7): create-if-absent, label-diffed no-op otherwise. Networks are never recreated -- name is the whole identity. */
export async function ensureNetwork(
  docker: DockerClient,
  name: string,
  labels: { service?: string; plan: string },
): Promise<StepResult> {
  const existing = await docker.findManagedNetworkByName(name);
  const confighash = computeNetworkConfigHash(name);
  if (existing) {
    return { step: `ensureNetwork:${name}`, changed: false, detail: "already exists" };
  }
  await docker.createNetwork(
    name,
    baseLabels({
      "wanfw.plan": labels.plan,
      "wanfw.confighash": confighash,
      ...(labels.service ? { "wanfw.service": labels.service } : {}),
    }),
  );
  return { step: `ensureNetwork:${name}`, changed: true, detail: "created" };
}

/** ensureVolume (§7): create-if-absent. Volumes are never recreated -- data must survive config edits. */
export async function ensureVolume(
  docker: DockerClient,
  name: string,
  labels: { service: string; plan: string },
): Promise<StepResult> {
  const existing = await docker.findManagedVolumeByName(name);
  if (existing) {
    return { step: `ensureVolume:${name}`, changed: false, detail: "already exists" };
  }
  const confighash = computeVolumeConfigHash(name);
  await docker.createVolume(
    name,
    baseLabels({ "wanfw.service": labels.service, "wanfw.plan": labels.plan, "wanfw.confighash": confighash }),
  );
  return { step: `ensureVolume:${name}`, changed: true, detail: "created" };
}

function bindsFromMounts(mounts: MountSpec[]): string[] {
  return mounts.map((m) => `${m.source}:${m.target}${m.readOnly ? ":ro" : ""}`);
}

/**
 * ensureContainer (§7 idempotency contract): compares the live container's
 * `wanfw.confighash` label to the freshly computed hash of the full spec.
 * Same hash -> no-op. Different (or absent, i.e. never created) -> Docker
 * cannot reconfigure an existing container's image/mounts/devices/etc. in
 * place, so we remove and recreate.
 */
export async function ensureContainer(
  docker: DockerClient,
  name: string,
  spec: ContainerSpec,
  labels: { service: string; plan: string },
): Promise<StepResult> {
  const confighash = computeConfigHash(spec);
  const existing = await docker.findManagedContainerByName(name);
  if (existing && existing.labels["wanfw.confighash"] === confighash) {
    return { step: `ensureContainer:${name}`, changed: false, detail: "unchanged" };
  }

  if (existing) {
    await docker.removeContainer(existing.id);
  }

  const options: CreateContainerOptions = {
    name,
    image: spec.image,
    cmd: spec.cmd,
    entrypoint: spec.entrypoint,
    env: spec.env,
    binds: bindsFromMounts((spec.mounts ?? []).filter((m) => m.type === "bind" || m.type === "volume")),
    devices: spec.devices,
    networkMode: spec.networkMode,
    ports: spec.ports,
    capAdd: spec.capAdd,
    privileged: spec.privileged,
    securityOpt: spec.securityOpt,
    user: spec.user,
    readOnlyRootfs: spec.readOnly,
    memory: spec.resources?.memory ? parseMemory(spec.resources.memory) : undefined,
    cpus: spec.resources?.cpus ? Number(spec.resources.cpus) : undefined,
    restartPolicy: spec.restart,
    primaryNetwork: spec.networks?.[0],
    labels: baseLabels({
      "wanfw.service": labels.service,
      "wanfw.plan": labels.plan,
      "wanfw.confighash": confighash,
      ...(spec.labels ?? {}),
    }),
  };

  const created = await docker.createContainer(options);
  await docker.startContainer(created.id);
  return { step: `ensureContainer:${name}`, changed: true, detail: existing ? "recreated" : "created" };
}

function parseMemory(mem: string): number {
  const match = /^(\d+)([kKmMgG]?)$/.exec(mem.trim());
  if (!match) return Number(mem) || 0;
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
  return value * multiplier;
}

/** connect (§7): attach a container to an additional network if not already attached. */
export async function connect(docker: DockerClient, containerName: string, networkName: string): Promise<StepResult> {
  const container = await docker.findManagedContainerByName(containerName);
  if (container?.networks.includes(networkName)) {
    return { step: `connect:${containerName}->${networkName}`, changed: false, detail: "already connected" };
  }
  if (!container) {
    return { step: `connect:${containerName}->${networkName}`, changed: false, detail: "container not found (will retry next reconcile)" };
  }
  await docker.connectNetwork(container.id, networkName);
  return { step: `connect:${containerName}->${networkName}`, changed: true, detail: "connected" };
}
