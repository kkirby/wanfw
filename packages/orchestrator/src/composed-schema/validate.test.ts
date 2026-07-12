import { describe, expect, it } from "vitest";
import { CORE_SCHEMAS } from "@wanfw/core-schemas";
import { validateDraftDocument } from "./validate.js";
import type { ComposedSchema } from "./compose.js";

function bareComposed(): ComposedSchema {
  return {
    envelope: CORE_SCHEMAS.envelope,
    framework: CORE_SCHEMAS.framework,
    service: CORE_SCHEMAS.service,
    pluginConfigSchemas: {},
  };
}

describe("validateDraftDocument", () => {
  it("accepts a valid Service document", () => {
    const result = validateDraftDocument(bareComposed(), {
      schemaVersion: 1,
      kind: "Service",
      metadata: { id: "jellyfin" },
      spec: {
        deploy: { plugin: "deploy-docker" },
        expose: { hostname: "jellyfin", backendPort: 8096, backendProtocol: "http" },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects an envelope-invalid draft with readable errors", () => {
    const result = validateDraftDocument(bareComposed(), { kind: "Service" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a spec that fails the kind-specific schema", () => {
    const result = validateDraftDocument(bareComposed(), {
      schemaVersion: 1,
      kind: "Service",
      metadata: { id: "jellyfin" },
      spec: { deploy: { plugin: "deploy-docker" } }, // missing required "expose"
    });
    expect(result.valid).toBe(false);
  });

  it("accepts a PluginConfig draft without further spec validation (validated at its own anchor)", () => {
    const result = validateDraftDocument(bareComposed(), {
      schemaVersion: 1,
      kind: "PluginConfig",
      metadata: { id: "dns-namecheap" },
      spec: { pluginId: "dns-namecheap", config: {} },
    });
    expect(result.valid).toBe(true);
  });

  it("is a pure function: repeated calls with the same input produce the same output, no shared state", () => {
    const composed = bareComposed();
    const draft = {
      schemaVersion: 1,
      kind: "Service",
      metadata: { id: "jellyfin" },
      spec: {
        deploy: { plugin: "deploy-docker" },
        expose: { hostname: "jellyfin", backendPort: 8096, backendProtocol: "http" },
      },
    };
    const first = validateDraftDocument(composed, draft);
    const second = validateDraftDocument(composed, draft);
    expect(first).toEqual(second);
  });

  it("gracefully rejects a non-object draft instead of throwing", () => {
    const result = validateDraftDocument(bareComposed(), "not an object");
    expect(result.valid).toBe(false);
  });

  it("validates a deploy anchor mounted from a plugin configSchema (parity with what the orchestrator would enforce)", () => {
    const composed = bareComposed();
    composed.service = {
      ...(CORE_SCHEMAS.service as object),
      properties: {
        ...(CORE_SCHEMAS.service as { properties: object }).properties,
        deploy: {
          type: "object",
          properties: { plugin: { type: "string" }, image: { type: "string" } },
          required: ["plugin", "image"],
        },
      },
    };

    const missingImage = validateDraftDocument(composed, {
      schemaVersion: 1,
      kind: "Service",
      metadata: { id: "jellyfin" },
      spec: {
        deploy: { plugin: "deploy-docker" },
        expose: { hostname: "jellyfin", backendPort: 8096, backendProtocol: "http" },
      },
    });
    expect(missingImage.valid).toBe(false);

    const withImage = validateDraftDocument(composed, {
      schemaVersion: 1,
      kind: "Service",
      metadata: { id: "jellyfin" },
      spec: {
        deploy: { plugin: "deploy-docker", image: "jellyfin/jellyfin:10.9.11" },
        expose: { hostname: "jellyfin", backendPort: 8096, backendProtocol: "http" },
      },
    });
    expect(withImage.valid).toBe(true);
  });
});
