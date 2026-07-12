import { describe, expect, it } from "vitest";
import { validateContainerSpec, type Grant } from "./validate-plan.js";
import type { ContainerSpec } from "./container-spec.js";

const baseSpec: ContainerSpec = { image: "jellyfin/jellyfin:10.9.11" };
const imageGrant: Grant = { cap: "docker.image.pull", scope: { repos: ["*"] } };

describe("validateContainerSpec: §12.1 canonical adversarial scenario", () => {
  it("a plan touching /dev/sda fails against a docker.device grant scoped /dev/dri/*, even though honest and trusted", () => {
    const grants: Grant[] = [imageGrant, { cap: "docker.device", scope: { paths: ["/dev/dri/*"] } }];
    const spec: ContainerSpec = { ...baseSpec, devices: ["/dev/sda"] };
    const result = validateContainerSpec("jellyfin", spec, grants);

    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.field === "devices" && v.cap === "docker.device")).toBe(true);
  });

  it("the same device grant correctly allows /dev/dri/renderD128", () => {
    const grants: Grant[] = [imageGrant, { cap: "docker.device", scope: { paths: ["/dev/dri/*"] } }];
    const spec: ContainerSpec = { ...baseSpec, devices: ["/dev/dri/renderD128"] };
    const result = validateContainerSpec("jellyfin", spec, grants);
    expect(result.ok).toBe(true);
    expect(result.tier).toBe("powerful");
  });
});

describe("validateContainerSpec: untrusted-plugin plans fail", () => {
  it("zero grants (untrusted/revoked plugin) fails every capability-gated field", () => {
    const spec: ContainerSpec = { ...baseSpec, devices: ["/dev/dri/renderD128"] };
    const result = validateContainerSpec("jellyfin", spec, []); // no grants at all
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});

describe("validateContainerSpec: §12.1 table, one pass + one violation per row", () => {
  it("image: docker.image.pull -- pass with matching repo glob, fail without", () => {
    const pass = validateContainerSpec("svc", baseSpec, [imageGrant]);
    expect(pass.violations.filter((v) => v.field === "image")).toEqual([]);

    const fail = validateContainerSpec("svc", baseSpec, [{ cap: "docker.image.pull", scope: { repos: ["other/*"] } }]);
    expect(fail.violations.some((v) => v.field === "image")).toBe(true);
  });

  it("mounts (volume): docker.volume.named -- pass within own service prefix, fail outside it", () => {
    const pass = validateContainerSpec("jellyfin", {
      ...baseSpec,
      mounts: [{ type: "volume", source: "wanfw_jellyfin-config", target: "/config" }],
    }, [imageGrant]);
    expect(pass.violations).toEqual([]);

    const fail = validateContainerSpec("jellyfin", {
      ...baseSpec,
      mounts: [{ type: "volume", source: "wanfw_other-service-config", target: "/config" }],
    }, [imageGrant]);
    expect(fail.violations.some((v) => v.cap === "docker.volume.named")).toBe(true);
  });

  it("mounts (bind): docker.mount.bind -- pass with matching path glob, fail without", () => {
    const grants: Grant[] = [imageGrant, { cap: "docker.mount.bind", scope: { paths: ["/srv/media/*"] } }];
    const pass = validateContainerSpec("svc", {
      ...baseSpec,
      mounts: [{ type: "bind", source: "/srv/media/movies", target: "/media", readOnly: true }],
    }, grants);
    expect(pass.violations).toEqual([]);
    expect(pass.tier).toBe("powerful");

    const fail = validateContainerSpec("svc", {
      ...baseSpec,
      mounts: [{ type: "bind", source: "/etc/passwd", target: "/x" }],
    }, grants);
    expect(fail.violations.some((v) => v.cap === "docker.mount.bind")).toBe(true);
  });

  it("devices: docker.device -- rejects a non-/dev/* path outright regardless of grants", () => {
    const grants: Grant[] = [imageGrant, { cap: "docker.device", scope: { paths: ["*"] } }];
    const result = validateContainerSpec("svc", { ...baseSpec, devices: ["/etc/shadow"] }, grants);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/must match \/dev\/\*/);
  });

  it("networkMode=host: docker.network.host -- pass with grant, fail without", () => {
    const pass = validateContainerSpec("svc", { ...baseSpec, networkMode: "host" }, [imageGrant, { cap: "docker.network.host", scope: {} }]);
    expect(pass.violations).toEqual([]);
    expect(pass.tier).toBe("powerful");

    const fail = validateContainerSpec("svc", { ...baseSpec, networkMode: "host" }, [imageGrant]);
    expect(fail.violations.some((v) => v.cap === "docker.network.host")).toBe(true);
  });

  it("privileged: docker.privileged -- pass with grant, fail without", () => {
    const pass = validateContainerSpec("svc", { ...baseSpec, privileged: true }, [imageGrant, { cap: "docker.privileged", scope: {} }]);
    expect(pass.violations).toEqual([]);

    const fail = validateContainerSpec("svc", { ...baseSpec, privileged: true }, [imageGrant]);
    expect(fail.violations.some((v) => v.cap === "docker.privileged")).toBe(true);
  });

  it("capAdd: docker.capabilities -- pass with matching cap list, fail without", () => {
    const grants: Grant[] = [imageGrant, { cap: "docker.capabilities", scope: { caps: ["NET_ADMIN"] } }];
    const pass = validateContainerSpec("svc", { ...baseSpec, capAdd: ["NET_ADMIN"] }, grants);
    expect(pass.violations).toEqual([]);

    const fail = validateContainerSpec("svc", { ...baseSpec, capAdd: ["SYS_ADMIN"] }, grants);
    expect(fail.violations.some((v) => v.cap === "docker.capabilities")).toBe(true);
  });

  it("ports: docker.ports.publish -- pass with matching port grant, fail without", () => {
    const grants: Grant[] = [imageGrant, { cap: "docker.ports.publish", scope: { ports: [80, 443] } }];
    const pass = validateContainerSpec("svc", { ...baseSpec, ports: [443] }, grants);
    expect(pass.violations).toEqual([]);

    const fail = validateContainerSpec("svc", { ...baseSpec, ports: [8080] }, grants);
    expect(fail.violations.some((v) => v.cap === "docker.ports.publish")).toBe(true);
  });

  it("networks: docker.network.attach -- pass on own service network, fail on an arbitrary one", () => {
    const pass = validateContainerSpec("jellyfin", { ...baseSpec, networks: ["wanfw_svc_jellyfin"] }, [imageGrant]);
    expect(pass.violations).toEqual([]);

    const fail = validateContainerSpec("jellyfin", { ...baseSpec, networks: ["wanfw_svc_other"] }, [imageGrant]);
    expect(fail.violations.some((v) => v.cap === "docker.network.attach")).toBe(true);
  });

  it("securityOpt/user/env/cmd/resources/labels/restart: always baseline, never gated", () => {
    const spec: ContainerSpec = {
      ...baseSpec,
      securityOpt: ["no-new-privileges"],
      user: "1000:1000",
      env: { TZ: "UTC" },
      cmd: ["--foo"],
      resources: { memory: "1g" },
      labels: { app: "jellyfin" },
      restart: "unless-stopped",
    };
    const result = validateContainerSpec("svc", spec, [imageGrant]);
    expect(result.ok).toBe(true);
    expect(result.tier).toBe("baseline");
  });
});

describe("validateContainerSpec: env-key secret heuristic is a warning, never a gate", () => {
  it("flags a suspicious env key as a warning without failing validation", () => {
    const spec: ContainerSpec = { ...baseSpec, env: { API_TOKEN: "plaintext-value", TZ: "UTC" } };
    const result = validateContainerSpec("svc", spec, [imageGrant]);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.field === "env.API_TOKEN")).toBe(true);
    expect(result.warnings.some((w) => w.field === "env.TZ")).toBe(false);
  });

  it("matches *_KEY, *_SECRET, and PASSWORD* shaped names too", () => {
    const spec: ContainerSpec = { ...baseSpec, env: { DB_PASSWORD: "x", STRIPE_SECRET: "y", API_KEY: "z" } };
    const result = validateContainerSpec("svc", spec, [imageGrant]);
    expect(result.warnings.map((w) => w.field).sort()).toEqual(["env.API_KEY", "env.DB_PASSWORD", "env.STRIPE_SECRET"]);
  });
});

describe("validateContainerSpec: powerful projection stability", () => {
  const grants: Grant[] = [
    imageGrant,
    { cap: "docker.device", scope: { paths: ["/dev/dri/*"] } },
    { cap: "docker.mount.bind", scope: { paths: ["/srv/media/*"] } },
  ];
  const powerfulSpec: ContainerSpec = {
    ...baseSpec,
    devices: ["/dev/dri/renderD128"],
    mounts: [{ type: "bind", source: "/srv/media", target: "/media", readOnly: true }],
    env: { TZ: "UTC" },
  };

  it("an env-var edit does not change the projection hash", () => {
    const a = validateContainerSpec("jellyfin", powerfulSpec, grants);
    const b = validateContainerSpec("jellyfin", { ...powerfulSpec, env: { TZ: "America/Chicago" } }, grants);
    expect(a.projectionHash).toBe(b.projectionHash);
  });

  it("an image tag bump changes the projection hash", () => {
    const a = validateContainerSpec("jellyfin", powerfulSpec, grants);
    const b = validateContainerSpec("jellyfin", { ...powerfulSpec, image: "jellyfin/jellyfin:10.9.12" }, grants);
    expect(a.projectionHash).not.toBe(b.projectionHash);
  });

  it("a device path change changes the projection hash", () => {
    const a = validateContainerSpec("jellyfin", powerfulSpec, grants);
    const b = validateContainerSpec("jellyfin", { ...powerfulSpec, devices: ["/dev/dri/renderD129"] }, grants);
    expect(a.projectionHash).not.toBe(b.projectionHash);
  });

  it("a baseline-only spec has no projection hash at all", () => {
    const result = validateContainerSpec("svc", baseSpec, [imageGrant]);
    expect(result.tier).toBe("baseline");
    expect(result.projectionHash).toBeUndefined();
  });
});
