import { describe, expect, it } from "vitest";
import { invokePluginForTest } from "@wanfw/plugin-sdk";
import { planTask, PACKAGE_NAME } from "./index.js";

describe("deploy-docker plugin", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("deploy-docker");
  });

  it("maps a Jellyfin-shaped service doc (spec §1.2/§5.4) to the expected ContainerSpec", async () => {
    const { result, error } = await invokePluginForTest({
      task: planTask,
      input: {
        service: {
          deploy: {
            plugin: "deploy-docker",
            image: "jellyfin/jellyfin:10.9.11",
            env: { TZ: "America/Chicago" },
            mounts: [
              { type: "volume", name: "jellyfin-config", target: "/config" },
              { type: "bind", source: "/srv/media", target: "/media", readOnly: true },
            ],
            devices: ["/dev/dri/renderD128"],
            resources: { memory: "4g" },
          },
        },
        context: { serviceId: "jellyfin" },
      },
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      image: "jellyfin/jellyfin:10.9.11",
      env: { TZ: "America/Chicago" },
      mounts: [
        { type: "volume", source: "wanfw_jellyfin_jellyfin-config", target: "/config", readOnly: undefined },
        { type: "bind", source: "/srv/media", target: "/media", readOnly: true },
      ],
      devices: ["/dev/dri/renderD128"],
      resources: { memory: "4g" },
    });
  });

  it("emits a /var/run/docker.sock bind mount verbatim -- classification/gating is the orchestrator's job (T3.6/T3.7), not this plugin's", async () => {
    const { result, error } = await invokePluginForTest({
      task: planTask,
      input: {
        service: {
          deploy: {
            plugin: "deploy-docker",
            image: "some/watchtower:latest",
            mounts: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }],
          },
        },
        context: { serviceId: "watchtower" },
      },
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      mounts: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock", readOnly: undefined }],
    });
  });

  it("makes zero host API calls -- purely declarative, per ADR-4 item 1", async () => {
    const { hostCalls } = await invokePluginForTest({
      task: planTask,
      input: {
        service: { deploy: { plugin: "deploy-docker", image: "kavita/kavita:latest" } },
        context: { serviceId: "kavita" },
      },
    });
    expect(hostCalls).toEqual([]);
  });

  it("omits optional fields entirely rather than emitting them as null/undefined", async () => {
    const { result } = await invokePluginForTest({
      task: planTask,
      input: {
        service: { deploy: { plugin: "deploy-docker", image: "kavita/kavita:latest" } },
        context: { serviceId: "kavita" },
      },
    });
    expect(result).toEqual({ image: "kavita/kavita:latest" });
  });
});
