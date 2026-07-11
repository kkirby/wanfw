import { describe, expect, it } from "vitest";
import { compileCoreValidators, createAjv } from "./validators.js";
import { CORE_SCHEMAS } from "./schemas.js";

describe("core schemas are valid JSON Schema 2020-12", () => {
  it("all four core schemas compile without throwing", () => {
    expect(() => compileCoreValidators()).not.toThrow();
  });

  it("each schema declares the 2020-12 dialect", () => {
    for (const schema of Object.values(CORE_SCHEMAS)) {
      expect((schema as { $schema: string }).$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
    }
  });
});

describe("envelope schema", () => {
  const { envelope } = compileCoreValidators();

  it("accepts a valid Service envelope", () => {
    const valid = envelope({
      schemaVersion: 1,
      kind: "Service",
      metadata: { id: "jellyfin", displayName: "Jellyfin" },
      spec: {},
    });
    expect(valid).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const valid = envelope({
      schemaVersion: 1,
      kind: "NotAKind",
      metadata: { id: "x" },
      spec: {},
    });
    expect(valid).toBe(false);
  });

  it("rejects a metadata.id with uppercase or invalid characters", () => {
    const valid = envelope({
      schemaVersion: 1,
      kind: "Service",
      metadata: { id: "Jellyfin_1" },
      spec: {},
    });
    expect(valid).toBe(false);
  });

  it("rejects additional top-level properties", () => {
    const valid = envelope({
      schemaVersion: 1,
      kind: "Service",
      metadata: { id: "jellyfin" },
      spec: {},
      extra: true,
    });
    expect(valid).toBe(false);
  });
});

describe("framework schema", () => {
  const { framework } = compileCoreValidators();

  it("accepts a minimal valid framework spec", () => {
    const valid = framework({
      domain: "example.tld",
      deploymentMode: "subdomain",
      acmeEmail: "ops@example.tld",
      roles: { networkProvider: "network-bridge", proxyEngine: "proxy-caddy" },
    });
    expect(valid).toBe(true);
  });

  it("rejects deploymentMode outside the enum", () => {
    const valid = framework({
      domain: "example.tld",
      deploymentMode: "vpn",
      acmeEmail: "ops@example.tld",
      roles: { networkProvider: "network-bridge", proxyEngine: "proxy-caddy" },
    });
    expect(valid).toBe(false);
  });

  it("accepts deploymentMode=port (modeled, not implemented until v1.1)", () => {
    const valid = framework({
      domain: "example.tld",
      deploymentMode: "port",
      acmeEmail: "ops@example.tld",
      roles: { networkProvider: "network-bridge", proxyEngine: "proxy-caddy" },
    });
    expect(valid).toBe(true);
  });

  it("rejects an invalid acmeEmail", () => {
    const valid = framework({
      domain: "example.tld",
      deploymentMode: "subdomain",
      acmeEmail: "not-an-email",
      roles: { networkProvider: "network-bridge", proxyEngine: "proxy-caddy" },
    });
    expect(valid).toBe(false);
  });
});

describe("service schema", () => {
  const { service } = compileCoreValidators();

  it("accepts the §1.2 Jellyfin-shaped spec.expose plus an open spec.deploy anchor", () => {
    const valid = service({
      deploy: {
        plugin: "deploy-docker",
        image: "jellyfin/jellyfin:10.9.11",
      },
      expose: {
        hostname: "jellyfin",
        backendPort: 8096,
        backendProtocol: "http",
        isolationTier: "standard",
      },
    });
    expect(valid).toBe(true);
  });

  it("rejects isolationTier outside the enum", () => {
    const valid = service({
      deploy: { plugin: "deploy-docker" },
      expose: {
        hostname: "jellyfin",
        backendPort: 8096,
        backendProtocol: "http",
        isolationTier: "sandboxed",
      },
    });
    expect(valid).toBe(false);
  });

  it("accepts isolationTier=quarantine (modeled, v1.1 execution deferred per ADR-2)", () => {
    const valid = service({
      deploy: { plugin: "deploy-docker" },
      expose: {
        hostname: "jellyfin",
        backendPort: 8096,
        backendProtocol: "http",
        isolationTier: "quarantine",
      },
    });
    expect(valid).toBe(true);
  });

  it("rejects a missing spec.deploy.plugin discriminator", () => {
    const valid = service({
      deploy: {},
      expose: { hostname: "jellyfin", backendPort: 8096, backendProtocol: "http" },
    });
    expect(valid).toBe(false);
  });
});

describe("ajv instance", () => {
  it("is strict mode", () => {
    const ajv = createAjv();
    expect(ajv.opts.strict).toBe(true);
  });
});
