import type {
  CreateContainerOptions,
  DockerClient,
  DockerContainerInfo,
  DockerNetworkInfo,
  DockerVolumeInfo,
} from "./docker-client.js";

/** In-memory fake for unit-testing ensure.ts primitives without a live Docker daemon. */
export class FakeDockerClient implements DockerClient {
  networks = new Map<string, DockerNetworkInfo>();
  volumes = new Map<string, DockerVolumeInfo>();
  containers = new Map<string, DockerContainerInfo>();
  execCalls: Array<{ containerName: string; cmd: string[] }> = [];
  execResult: { exitCode: number; output: string } = { exitCode: 0, output: "ok" };
  private nextId = 1;

  async findManagedNetworkByName(name: string) {
    return this.networks.get(name);
  }

  async createNetwork(name: string, labels: Record<string, string>) {
    const info = { id: `net-${this.nextId++}`, name, labels };
    this.networks.set(name, info);
    return info;
  }

  async findManagedVolumeByName(name: string) {
    return this.volumes.get(name);
  }

  async createVolume(name: string, labels: Record<string, string>) {
    const info = { name, labels };
    this.volumes.set(name, info);
    return info;
  }

  async findManagedContainerByName(name: string) {
    return this.containers.get(name);
  }

  async createContainer(options: CreateContainerOptions) {
    const info: DockerContainerInfo = { id: `ctr-${this.nextId++}`, name: options.name, labels: options.labels, networks: [], state: "created" };
    this.containers.set(options.name, info);
    return info;
  }

  async removeContainer(id: string) {
    for (const [name, info] of this.containers) {
      if (info.id === id) this.containers.delete(name);
    }
  }

  async startContainer(id: string) {
    for (const info of this.containers.values()) {
      if (info.id === id) info.state = "running";
    }
  }

  async connectNetwork(containerId: string, networkName: string) {
    for (const info of this.containers.values()) {
      if (info.id === containerId && !info.networks.includes(networkName)) {
        info.networks.push(networkName);
      }
    }
  }

  async exec(containerName: string, cmd: string[]) {
    this.execCalls.push({ containerName, cmd });
    return this.execResult;
  }
}
