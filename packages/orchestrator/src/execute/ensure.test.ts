import { describe, expect, it } from "vitest";
import { FakeDockerClient } from "./fake-docker-client.js";
import { ensureNetwork, ensureVolume, ensureContainer, connect } from "./ensure.js";
import type { ContainerSpec } from "../validate/index.js";

describe("ensure primitives (§7 EXECUTE, ADR-9)", () => {
  it("ensureNetwork creates once, no-ops on the second call", async () => {
    const docker = new FakeDockerClient();
    const first = await ensureNetwork(docker, "wanfw_svc_jellyfin", { service: "jellyfin", plan: "p1" });
    expect(first.changed).toBe(true);
    const second = await ensureNetwork(docker, "wanfw_svc_jellyfin", { service: "jellyfin", plan: "p2" });
    expect(second.changed).toBe(false);
    expect(docker.networks.size).toBe(1);
  });

  it("ensureVolume creates once, preserves data (never recreated) on later calls", async () => {
    const docker = new FakeDockerClient();
    const first = await ensureVolume(docker, "wanfw_jellyfin_config", { service: "jellyfin", plan: "p1" });
    expect(first.changed).toBe(true);
    const second = await ensureVolume(docker, "wanfw_jellyfin_config", { service: "jellyfin", plan: "p2" });
    expect(second.changed).toBe(false);
  });

  it("ensureContainer: same spec twice is a no-op the second time (idempotency contract)", async () => {
    const docker = new FakeDockerClient();
    const spec: ContainerSpec = { image: "jellyfin/jellyfin:10.9.11", env: { TZ: "UTC" } };
    const first = await ensureContainer(docker, "wanfw_jellyfin", spec, { service: "jellyfin", plan: "p1" });
    expect(first.changed).toBe(true);
    expect(first.detail).toBe("created");

    const second = await ensureContainer(docker, "wanfw_jellyfin", spec, { service: "jellyfin", plan: "p2" });
    expect(second.changed).toBe(false);
    expect(second.detail).toBe("unchanged");
    expect(docker.containers.size).toBe(1);
  });

  it("ensureContainer: an env-only edit still recreates (confighash covers the FULL spec, unlike the approval projection hash)", async () => {
    const docker = new FakeDockerClient();
    const specA: ContainerSpec = { image: "jellyfin/jellyfin:10.9.11", env: { TZ: "UTC" } };
    await ensureContainer(docker, "wanfw_jellyfin", specA, { service: "jellyfin", plan: "p1" });
    const firstId = docker.containers.get("wanfw_jellyfin")!.id;

    const specB: ContainerSpec = { image: "jellyfin/jellyfin:10.9.11", env: { TZ: "America/Chicago" } };
    const result = await ensureContainer(docker, "wanfw_jellyfin", specB, { service: "jellyfin", plan: "p2" });
    expect(result.changed).toBe(true);
    expect(result.detail).toBe("recreated");
    expect(docker.containers.get("wanfw_jellyfin")!.id).not.toBe(firstId);
  });

  it("ensureContainer: an image bump recreates", async () => {
    const docker = new FakeDockerClient();
    const specA: ContainerSpec = { image: "jellyfin/jellyfin:10.9.11" };
    await ensureContainer(docker, "wanfw_jellyfin", specA, { service: "jellyfin", plan: "p1" });
    const specB: ContainerSpec = { image: "jellyfin/jellyfin:10.9.12" };
    const result = await ensureContainer(docker, "wanfw_jellyfin", specB, { service: "jellyfin", plan: "p2" });
    expect(result.changed).toBe(true);
    expect(result.detail).toBe("recreated");
  });

  it("connect attaches a container to a network once, then no-ops", async () => {
    const docker = new FakeDockerClient();
    const spec: ContainerSpec = { image: "jellyfin/jellyfin:10.9.11" };
    await ensureContainer(docker, "wanfw_jellyfin", spec, { service: "jellyfin", plan: "p1" });
    const first = await connect(docker, "wanfw_jellyfin", "wanfw_svc_jellyfin");
    expect(first.changed).toBe(true);
    const second = await connect(docker, "wanfw_jellyfin", "wanfw_svc_jellyfin");
    expect(second.changed).toBe(false);
  });

  it("created objects carry ADR-9 labels: wanfw.managed, wanfw.service, wanfw.plan, wanfw.confighash", async () => {
    const docker = new FakeDockerClient();
    const spec: ContainerSpec = { image: "jellyfin/jellyfin:10.9.11" };
    await ensureContainer(docker, "wanfw_jellyfin", spec, { service: "jellyfin", plan: "plan-xyz" });
    const info = docker.containers.get("wanfw_jellyfin")!;
    expect(info.labels["wanfw.managed"]).toBe("true");
    expect(info.labels["wanfw.service"]).toBe("jellyfin");
    expect(info.labels["wanfw.plan"]).toBe("plan-xyz");
    expect(info.labels["wanfw.confighash"]).toMatch(/^[a-f0-9]{64}$/);
  });
});
