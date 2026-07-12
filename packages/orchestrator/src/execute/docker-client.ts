import Docker from "dockerode";

/**
 * Narrow seam over dockerode (§7 EXECUTE, ADR-9). Kept as an interface so
 * the primitives in ensure.ts are unit-testable against a fake without a
 * live Docker daemon; buildRealDockerClient() is the only file that touches
 * the dockerode package directly.
 */
export interface DockerNetworkInfo {
  id: string;
  name: string;
  labels: Record<string, string>;
}

export interface DockerVolumeInfo {
  name: string;
  labels: Record<string, string>;
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  labels: Record<string, string>;
  networks: string[];
  state: string;
}

export interface CreateContainerOptions {
  name: string;
  image: string;
  cmd?: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  mounts?: Array<{ type: "volume" | "bind"; source: string; target: string; readOnly?: boolean }>;
  devices?: string[];
  networkMode?: string;
  ports?: number[];
  capAdd?: string[];
  privileged?: boolean;
  securityOpt?: string[];
  user?: string;
  readOnlyRootfs?: boolean;
  memory?: number; // bytes
  cpus?: number;
  labels: Record<string, string>;
  restartPolicy?: string;
  primaryNetwork?: string;
}

export interface DockerClient {
  findManagedNetworkByName(name: string): Promise<DockerNetworkInfo | undefined>;
  createNetwork(name: string, labels: Record<string, string>): Promise<DockerNetworkInfo>;

  findManagedVolumeByName(name: string): Promise<DockerVolumeInfo | undefined>;
  createVolume(name: string, labels: Record<string, string>): Promise<DockerVolumeInfo>;

  findManagedContainerByName(name: string): Promise<DockerContainerInfo | undefined>;
  createContainer(options: CreateContainerOptions): Promise<DockerContainerInfo>;
  removeContainer(id: string): Promise<void>;
  startContainer(id: string): Promise<void>;
  connectNetwork(containerId: string, networkName: string): Promise<void>;
  exec(containerName: string, cmd: string[]): Promise<{ exitCode: number; output: string }>;

  /** OBSERVE/GC (§7, ADR-9): every list here is scoped to `wanfw.managed=true` -- unlabeled bystanders are structurally invisible, never queried. */
  listManagedContainers(): Promise<DockerContainerInfo[]>;
  listManagedNetworks(): Promise<DockerNetworkInfo[]>;
  listManagedVolumes(): Promise<DockerVolumeInfo[]>;
  removeNetwork(id: string): Promise<void>;
  removeVolume(name: string): Promise<void>;

  /**
   * `net.probeNetwork` (T5.2, ADR-1): attempts to actually create a
   * throwaway macvlan network on `parent`, then immediately removes it --
   * the only way to know for real whether macvlan works on a given host
   * interface (MAC filtering, no promiscuous mode, a WiFi uplink, etc. all
   * surface here as a Docker daemon error, not something inferable any
   * other way). The daemon validates against the *host's* real NIC
   * regardless of the orchestrator container's own network namespace
   * (`network_mode: "none"`, §12.5) -- this is a Docker API call over the
   * Unix socket, not something requiring the caller's own network access.
   * A syntactically valid but unrealistic throwaway subnet is fine: the
   * daemon still validates real parent-interface capability at creation
   * time regardless of whether the subnet reflects anything real.
   */
  probeMacvlan(parent: string): Promise<{ ok: boolean; reason?: string }>;
}

const MANAGED_LABEL = "wanfw.managed";

export function buildRealDockerClient(socketPath?: string): DockerClient {
  const docker = socketPath ? new Docker({ socketPath }) : new Docker();

  return {
    async findManagedNetworkByName(name) {
      const networks = await docker.listNetworks({ filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`], name: [name] }) });
      const match = networks.find((n) => n.Name === name);
      if (!match) return undefined;
      return { id: match.Id, name: match.Name, labels: match.Labels ?? {} };
    },

    async createNetwork(name, labels) {
      const created = await docker.createNetwork({ Name: name, Labels: labels, CheckDuplicate: true });
      return { id: created.id, name, labels };
    },

    async findManagedVolumeByName(name) {
      const { Volumes } = await docker.listVolumes({ filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`], name: [name] }) });
      const match = (Volumes ?? []).find((v) => v.Name === name);
      if (!match) return undefined;
      return { name: match.Name, labels: match.Labels ?? {} };
    },

    async createVolume(name, labels) {
      const created = await docker.createVolume({ Name: name, Labels: labels });
      return { name: created.Name, labels };
    },

    async findManagedContainerByName(name) {
      const containers = await docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`], name: [`^/${name}$`] }),
      });
      const match = containers.find((c) => c.Names.includes(`/${name}`));
      if (!match) return undefined;
      return {
        id: match.Id,
        name,
        labels: match.Labels ?? {},
        networks: Object.keys(match.NetworkSettings?.Networks ?? {}),
        state: match.State,
      };
    },

    async createContainer(options) {
      const images = await docker.listImages({ filters: JSON.stringify({ reference: [options.image] }) });
      if (images.length === 0) {
        await new Promise<void>((resolve, reject) => {
          docker.pull(options.image, (err: Error | null, stream: NodeJS.ReadableStream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (progressErr: Error | null) => (progressErr ? reject(progressErr) : resolve()));
          });
        });
      }
      // Structured HostConfig.Mounts, not the legacy Binds string array:
      // Binds is bind-mount-shaped and (contrary to the CLI's `-v` shorthand
      // translation) does not reliably attach named volumes when driving
      // the Engine API directly -- discovered live when a "volume" mount
      // silently produced no external mount at all, leaving the container
      // seeing its own image layer at that path instead of the shared
      // volume (T3.12).
      const mounts = (options.mounts ?? []).map((m) => ({
        Type: m.type,
        Source: m.source,
        Target: m.target,
        ReadOnly: m.readOnly ?? false,
      }));
      const container = await docker.createContainer({
        name: options.name,
        Image: options.image,
        Cmd: options.cmd,
        Entrypoint: options.entrypoint,
        Env: options.env ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`) : undefined,
        User: options.user,
        Labels: options.labels,
        ExposedPorts: options.ports
          ? Object.fromEntries(options.ports.map((p) => [`${p}/tcp`, {}]))
          : undefined,
        HostConfig: {
          Mounts: mounts.length > 0 ? mounts : undefined,
          Devices: (options.devices ?? []).map((d) => ({ PathOnHost: d, PathInContainer: d, CgroupPermissions: "rwm" })),
          NetworkMode: options.networkMode ?? options.primaryNetwork,
          PortBindings: options.ports
            ? Object.fromEntries(options.ports.map((p) => [`${p}/tcp`, [{ HostPort: String(p) }]]))
            : undefined,
          CapAdd: options.capAdd,
          Privileged: options.privileged,
          SecurityOpt: options.securityOpt,
          ReadonlyRootfs: options.readOnlyRootfs,
          Memory: options.memory,
          NanoCpus: options.cpus ? Math.round(options.cpus * 1e9) : undefined,
          RestartPolicy: options.restartPolicy ? { Name: options.restartPolicy } : undefined,
        },
      });
      return { id: container.id, name: options.name, labels: options.labels, networks: [], state: "created" };
    },

    async removeContainer(id) {
      const container = docker.getContainer(id);
      try {
        await container.stop({ t: 10 });
      } catch {
        // already stopped
      }
      await container.remove({ force: true });
    },

    async startContainer(id) {
      await docker.getContainer(id).start();
    },

    async connectNetwork(containerId, networkName) {
      const networks = await docker.listNetworks({ filters: JSON.stringify({ name: [networkName] }) });
      const net = networks.find((n) => n.Name === networkName);
      if (!net) throw new Error(`network ${networkName} not found`);
      await docker.getNetwork(net.Id).connect({ Container: containerId });
    },

    async listManagedContainers() {
      const containers = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }) });
      return containers.map((c) => ({
        id: c.Id,
        name: c.Names[0]?.replace(/^\//, "") ?? c.Id,
        labels: c.Labels ?? {},
        networks: Object.keys(c.NetworkSettings?.Networks ?? {}),
        state: c.State,
      }));
    },

    async listManagedNetworks() {
      const networks = await docker.listNetworks({ filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }) });
      return networks.map((n) => ({ id: n.Id, name: n.Name, labels: n.Labels ?? {} }));
    },

    async listManagedVolumes() {
      const { Volumes } = await docker.listVolumes({ filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }) });
      return (Volumes ?? []).map((v) => ({ name: v.Name, labels: v.Labels ?? {} }));
    },

    async removeNetwork(id) {
      await docker.getNetwork(id).remove();
    },

    async removeVolume(name) {
      await docker.getVolume(name).remove();
    },

    async probeMacvlan(parent) {
      const probeName = `wanfw-macvlan-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const created = await docker.createNetwork({
          Name: probeName,
          Driver: "macvlan",
          Options: { parent },
          // Link-local, deliberately unrealistic (§8.4's own reserved-range
          // guidance is about the *real* macvlan network, not this
          // throwaway probe) -- the daemon still validates real parent
          // capability at creation time regardless of subnet realism.
          IPAM: { Config: [{ Subnet: "169.254.100.0/24" }] },
        });
        await docker.getNetwork(created.id).remove();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },

    async exec(containerName, cmd) {
      const container = docker.getContainer(containerName);
      const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({});
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => resolve());
        stream.on("error", reject);
      });
      const inspect = await exec.inspect();
      return { exitCode: inspect.ExitCode ?? 0, output: Buffer.concat(chunks).toString("utf8") };
    },
  };
}

export { MANAGED_LABEL };
