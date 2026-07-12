import { describe, expect, it } from "vitest";
import {
  canonicalizePath,
  matchPathGlob,
  matchAnyPathGlob,
  matchNamePrefix,
  matchZone,
  matchPort,
  matchPortRange,
} from "./scope-matcher.js";

describe("canonicalizePath", () => {
  it("accepts a plain absolute path", () => {
    expect(canonicalizePath("/dev/dri/renderD128")).toBe("/dev/dri/renderD128");
  });

  it("rejects relative paths", () => {
    expect(canonicalizePath("dev/dri/renderD128")).toBeNull();
  });

  it("rejects paths containing ..", () => {
    expect(canonicalizePath("/dev/dri/../../etc/passwd")).toBeNull();
  });

  it("collapses repeated slashes", () => {
    expect(canonicalizePath("/dev//dri///renderD128")).toBe("/dev/dri/renderD128");
  });
});

describe("matchPathGlob (§12.1 canonical scenario)", () => {
  it("a /dev/dri/* grant matches /dev/dri/renderD128", () => {
    expect(matchPathGlob("/dev/dri/*", "/dev/dri/renderD128")).toBe(true);
  });

  it("a /dev/dri/* grant does NOT match /dev/sda -- the spec's exact adversarial example", () => {
    // "a plan with /dev/sda fails against a docker.device grant scoped
    // /dev/dri/* even though the plugin is trusted and honest" (§12.1).
    expect(matchPathGlob("/dev/dri/*", "/dev/sda")).toBe(false);
  });

  it("an exact-match pattern (no trailing /*) only matches that exact path", () => {
    expect(matchPathGlob("/srv/media", "/srv/media")).toBe(true);
    expect(matchPathGlob("/srv/media", "/srv/media/movies")).toBe(false);
  });

  it("rejects a path traversal attempt even if it would otherwise match", () => {
    expect(matchPathGlob("/dev/dri/*", "/dev/dri/../sda")).toBe(false);
  });

  it("matchAnyPathGlob checks a list of patterns", () => {
    expect(matchAnyPathGlob(["/dev/dri/*", "/dev/dvb/*"], "/dev/dvb/adapter0")).toBe(true);
    expect(matchAnyPathGlob(["/dev/dri/*", "/dev/dvb/*"], "/dev/sda")).toBe(false);
  });

  it("a root grant (\"/*\") matches any absolute path -- the degenerate case where the prefix-plus-slash check would otherwise require a spurious \"//\"", () => {
    expect(matchPathGlob("/*", "/dev/sda")).toBe(true);
    expect(matchPathGlob("/*", "/srv/media/movies")).toBe(true);
    expect(matchPathGlob("/*", "/")).toBe(true);
  });
});

describe("matchNamePrefix", () => {
  it("matches a plugin-prefixed secret name", () => {
    expect(matchNamePrefix(["cert-letsencrypt-dns01/*"], "cert-letsencrypt-dns01/acme-account-key")).toBe(true);
  });

  it("rejects a name outside the prefix (cross-plugin secret access)", () => {
    expect(matchNamePrefix(["cert-letsencrypt-dns01/*"], "dns-namecheap/api-key")).toBe(false);
  });

  it("supports exact-name patterns without a wildcard", () => {
    expect(matchNamePrefix(["exact-name"], "exact-name")).toBe(true);
    expect(matchNamePrefix(["exact-name"], "exact-name-2")).toBe(false);
  });
});

describe("matchZone", () => {
  it("matches an exact zone", () => {
    expect(matchZone(["example.tld"], "example.tld")).toBe(true);
    expect(matchZone(["example.tld"], "other.tld")).toBe(false);
  });

  it("a '*' grant matches any zone (T4.4's cert-issuer manifest, written before any operator's domain is known)", () => {
    expect(matchZone(["*"], "example.tld")).toBe(true);
    expect(matchZone(["*"], "literally-anything.tld")).toBe(true);
  });
});

describe("matchPort / matchPortRange", () => {
  it("matches individual ports", () => {
    expect(matchPort([80, 443], 443)).toBe(true);
    expect(matchPort([80, 443], 8080)).toBe(false);
  });

  it("matchPortRange requires every requested port to be granted", () => {
    expect(matchPortRange([80, 443], [80, 443])).toBe(true);
    expect(matchPortRange([80, 443], [80, 8080])).toBe(false);
  });
});
