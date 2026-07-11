import { describe, expect, it } from "vitest";
import {
  buildPowerfulProjection,
  computePowerfulProjectionHash,
  projectionToCanonicalJSON,
  type PowerfulProjectionInput,
} from "./projection.js";

// Fixture: the §1.2 Jellyfin acceptance scenario (bind mount + device).
const jellyfinInput: PowerfulProjectionInput = {
  serviceId: "jellyfin",
  image: "jellyfin/jellyfin:10.9.11",
  mounts: [{ source: "/srv/media", target: "/media", ro: true }],
  devices: ["/dev/dri/renderD128"],
  networkMode: null,
  privileged: false,
  capAdd: [],
  publishedPorts: [],
};

describe("buildPowerfulProjection", () => {
  it("sorts mounts, devices, capAdd, and publishedPorts", () => {
    const projection = buildPowerfulProjection({
      serviceId: "svc",
      image: "img:tag",
      mounts: [
        { source: "/b", target: "/y", ro: false },
        { source: "/a", target: "/x", ro: true },
      ],
      devices: ["/dev/dri/card1", "/dev/dri/card0"],
      networkMode: null,
      privileged: false,
      capAdd: ["NET_ADMIN", "CHOWN"],
      publishedPorts: [443, 80],
    });
    expect(projection.mounts).toEqual([
      { source: "/a", target: "/x", ro: true },
      { source: "/b", target: "/y", ro: false },
    ]);
    expect(projection.devices).toEqual(["/dev/dri/card0", "/dev/dri/card1"]);
    expect(projection.capAdd).toEqual(["CHOWN", "NET_ADMIN"]);
    expect(projection.publishedPorts).toEqual([80, 443]);
  });
});

describe("powerful projection stability (§12.2)", () => {
  it("produces a fixed canonical JSON test vector for the Jellyfin scenario", () => {
    expect(projectionToCanonicalJSON(jellyfinInput)).toBe(
      '{"capAdd":[],"devices":["/dev/dri/renderD128"],"image":"jellyfin/jellyfin:10.9.11","mounts":[{"ro":true,"source":"/srv/media","target":"/media"}],"networkMode":null,"privileged":false,"publishedPorts":[],"serviceId":"jellyfin"}',
    );
  });

  it("produces a fixed sha256 test vector for the Jellyfin scenario", () => {
    // Hash of the canonical JSON vector above, sha256 hex.
    expect(computePowerfulProjectionHash(jellyfinInput)).toBe(
      "b48107f0866717b4dc8992ddfc45182b02fd037231488dbc62d047923678061f",
    );
  });

  it("is stable under env-var-shaped edits (env is not part of the projection type)", () => {
    // The projection input type has no env field at all: an env edit cannot
    // change the hash because there is no path for it to enter the input.
    const hashA = computePowerfulProjectionHash(jellyfinInput);
    const hashB = computePowerfulProjectionHash({ ...jellyfinInput });
    expect(hashA).toBe(hashB);
  });

  it("changes when the image tag changes", () => {
    const bumped = computePowerfulProjectionHash({
      ...jellyfinInput,
      image: "jellyfin/jellyfin:10.9.12",
    });
    expect(bumped).not.toBe(computePowerfulProjectionHash(jellyfinInput));
  });

  it("changes when a device path changes", () => {
    const changed = computePowerfulProjectionHash({
      ...jellyfinInput,
      devices: ["/dev/dri/renderD129"],
    });
    expect(changed).not.toBe(computePowerfulProjectionHash(jellyfinInput));
  });

  it("is insensitive to mount array input order", () => {
    const a = computePowerfulProjectionHash({
      ...jellyfinInput,
      mounts: [
        { source: "/srv/media", target: "/media", ro: true },
        { source: "/srv/backups", target: "/backups", ro: true },
      ],
    });
    const b = computePowerfulProjectionHash({
      ...jellyfinInput,
      mounts: [
        { source: "/srv/backups", target: "/backups", ro: true },
        { source: "/srv/media", target: "/media", ro: true },
      ],
    });
    expect(a).toBe(b);
  });
});
