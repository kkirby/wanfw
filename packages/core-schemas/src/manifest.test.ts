import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadManifest,
  validateManifest,
  isFrameworkApiCompatible,
  resolveScopeTemplates,
  FRAMEWORK_API_VERSION,
} from "./manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "__fixtures__");

describe("loadManifest (fixture manifests)", () => {
  it("valid fixture passes", async () => {
    const result = await loadManifest(join(fixturesDir, "bundle-valid"));
    expect(result.valid).toBe(true);
    expect(result.manifest?.id).toBe("cert-letsencrypt-dns01");
    expect(result.errors).toEqual([]);
  });

  it("invalid fixture fails with errors naming the bad fields", async () => {
    const result = await loadManifest(join(fixturesDir, "bundle-invalid"));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("template-bearing fixture loads (templates resolved later, at grant time)", async () => {
    const result = await loadManifest(join(fixturesDir, "bundle-template"));
    expect(result.valid).toBe(true);
    expect(result.manifest?.capabilities[0]?.scope.zones).toEqual(["${framework.domain}", "sub.${framework.domain}"]);
  });

  it("missing manifest.json fails gracefully with a readable error", async () => {
    const result = await loadManifest(join(fixturesDir, "does-not-exist"));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/could not read manifest.json/);
  });
});

describe("validateManifest", () => {
  it("rejects unknown top-level properties (additionalProperties: false)", () => {
    const result = validateManifest({
      manifestVersion: 1,
      id: "x",
      version: "0.1.0",
      frameworkApi: "^1.0",
      types: ["deploy"],
      entrypoint: "dist/main.js",
      runtime: "node22",
      capabilities: [],
      somethingUnexpected: true,
    });
    expect(result.valid).toBe(false);
  });

  it("requires at least one capability field set (reason mandatory)", () => {
    const result = validateManifest({
      manifestVersion: 1,
      id: "x",
      version: "0.1.0",
      frameworkApi: "^1.0",
      types: ["deploy"],
      entrypoint: "dist/main.js",
      runtime: "node22",
      capabilities: [{ cap: "docker.device", scope: {} }],
    });
    expect(result.valid).toBe(false);
  });
});

describe("isFrameworkApiCompatible", () => {
  it("exact major.minor match is compatible", () => {
    expect(isFrameworkApiCompatible("^1.0", "1.0.0")).toBe(true);
  });

  it("higher patch on same minor is compatible", () => {
    expect(isFrameworkApiCompatible("^1.0", "1.0.5")).toBe(true);
  });

  it("higher minor is compatible (caret allows minor bumps)", () => {
    expect(isFrameworkApiCompatible("^1.0", "1.2.0")).toBe(true);
  });

  it("lower minor than required is incompatible", () => {
    expect(isFrameworkApiCompatible("^1.2", "1.1.9")).toBe(false);
  });

  it("lower patch than required (same minor) is incompatible", () => {
    expect(isFrameworkApiCompatible("^1.0.5", "1.0.3")).toBe(false);
  });

  it("different major is incompatible", () => {
    expect(isFrameworkApiCompatible("^1.0", "2.0.0")).toBe(false);
  });

  it("malformed range string is incompatible", () => {
    expect(isFrameworkApiCompatible("not-a-range", "1.0.0")).toBe(false);
  });

  it("defaults to the current FRAMEWORK_API_VERSION constant", () => {
    expect(isFrameworkApiCompatible(`^${FRAMEWORK_API_VERSION.split(".").slice(0, 2).join(".")}`)).toBe(true);
  });
});

describe("resolveScopeTemplates", () => {
  const context = { framework: { domain: "example.tld" } };

  it("resolves a single template placeholder", () => {
    expect(resolveScopeTemplates("${framework.domain}", context)).toBe("example.tld");
  });

  it("resolves templates embedded in a larger string", () => {
    expect(resolveScopeTemplates("sub.${framework.domain}", context)).toBe("sub.example.tld");
  });

  it("resolves templates nested in arrays and objects", () => {
    const scope = { zones: ["${framework.domain}", "other.tld"], nested: { host: "${framework.domain}" } };
    expect(resolveScopeTemplates(scope, context)).toEqual({
      zones: ["example.tld", "other.tld"],
      nested: { host: "example.tld" },
    });
  });

  it("leaves non-template strings and other value types untouched", () => {
    expect(resolveScopeTemplates("plain-string", context)).toBe("plain-string");
    expect(resolveScopeTemplates(42 as unknown as string, context)).toBe(42);
    expect(resolveScopeTemplates(null as unknown as string, context)).toBe(null);
  });
});
