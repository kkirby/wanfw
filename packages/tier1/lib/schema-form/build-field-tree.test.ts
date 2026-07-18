import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { CORE_SCHEMAS } from "@wanfw/core-schemas";
import { buildFieldTree } from "./build-field-tree.js";
import { validateDocument } from "./validate.js";
import type { FieldNode, JsonSchemaLike } from "./types.js";

function byPath(fields: FieldNode[]): Record<string, FieldNode> {
  return Object.fromEntries(fields.map((f) => [f.path, f] as const));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const deployDockerConfigSchema = JSON.parse(
  readFileSync(join(__dirname, "../../../../plugins/deploy-docker/config-schema.json"), "utf8"),
) as JsonSchemaLike;

/** Mirrors packages/orchestrator/src/composed-schema/compose.ts's real merge exactly (spec.deploy anchor = core + bound deploy plugin's properties). */
function composedServiceSchema(): JsonSchemaLike {
  const serviceSchema = structuredClone(CORE_SCHEMAS.service) as JsonSchemaLike;
  serviceSchema.properties!.deploy = {
    ...serviceSchema.properties!.deploy,
    properties: { plugin: { type: "string" }, ...deployDockerConfigSchema.properties },
  };
  return serviceSchema;
}

describe("buildFieldTree (T3.13, §5.5 composed schema)", () => {
  it("renders the deploy-docker config schema fixture into a field tree covering every JSON Schema shape it uses", () => {
    const fields = buildFieldTree(deployDockerConfigSchema);
    const byKey = byPath(fields);

    expect(byKey.image?.kind).toBe("string");
    expect(byKey.image?.required).toBe(true); // deploy-docker's own config-schema.json requires image at its top level
    expect(byKey.cmd?.kind).toBe("array-scalar");
    expect(byKey.devices?.kind).toBe("array-scalar");
    expect(byKey.ports).toMatchObject({ kind: "array-scalar", itemKind: "integer" });
    expect(byKey.env?.kind).toBe("map");
    expect(byKey.resources?.kind).toBe("object");
    expect((byKey.resources as { fields: unknown[] }).fields.length).toBeGreaterThan(0);
    expect(byKey.privileged?.kind).toBe("boolean");

    // mounts: array of oneOf { volume, bind } -- exactly the polymorphic case the plan calls out.
    expect(byKey.mounts?.kind).toBe("array-object");
    const variants = (byKey.mounts as { variants: Array<{ discriminatorValue?: string }> }).variants;
    expect(variants.map((v) => v.discriminatorValue).sort()).toEqual(["bind", "volume"]);
  });

  it("every top-level deploy-docker field has a real title and description, not a bare property-name label", () => {
    const fields = buildFieldTree(deployDockerConfigSchema);
    const byKey = byPath(fields);
    for (const key of ["image", "cmd", "entrypoint", "env", "mounts", "devices", "networkMode", "ports", "capAdd", "privileged", "securityOpt", "user", "readOnly", "resources", "labels", "restart"]) {
      const field = byKey[key];
      expect(field?.title, `${key} should have a title`).toBeTruthy();
      expect(field?.title, `${key}'s title should not just be its raw property key`).not.toBe(key);
      expect(field?.description, `${key} should have a description`).toBeTruthy();
    }
  });

  it("renders the full composed service schema (core spec.expose + spec.deploy merged with the bound plugin's schema, per §5.5)", () => {
    const fields = buildFieldTree(composedServiceSchema());
    const byKey = byPath(fields);

    expect(byKey.expose?.kind).toBe("object");
    const exposeFields = byPath((byKey.expose as { fields: FieldNode[] }).fields);
    expect(exposeFields.hostname?.required).toBe(true);
    expect(exposeFields.backendProtocol).toMatchObject({ kind: "string", enumValues: ["http", "https"] });

    expect(byKey.deploy?.kind).toBe("object");
    const deployFields = byPath((byKey.deploy as { fields: FieldNode[] }).fields);
    expect(deployFields.image?.kind).toBe("string"); // merged in from the deploy-docker plugin's schema
  });

  it("round-trips a Jellyfin-shaped document (spec §1.2/§5.4's own example) through the composed schema: valid, zero errors", () => {
    const jellyfinDoc = {
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
      expose: { hostname: "jellyfin.example.tld", backendPort: 8096, backendProtocol: "http", isolationTier: "standard" },
    };

    const result = validateDocument(composedServiceSchema(), jellyfinDoc);
    expect(result.valid).toBe(true);
    expect(result.errorsByPath).toEqual({});
  });

  it("surfaces Ajv errors on the exact right fields for an invalid document", () => {
    const invalidDoc = {
      deploy: { plugin: "deploy-docker", image: "kavita/kavita:latest", mounts: "not-an-array" },
      expose: { hostname: "kavita.example.tld", backendPort: 999999, backendProtocol: "ftp" },
    };

    const result = validateDocument(composedServiceSchema(), invalidDoc);
    expect(result.valid).toBe(false);
    expect(result.errorsByPath["deploy.mounts"]).toBeDefined(); // wrong type, merged in from the deploy-docker plugin's own schema
    expect(result.errorsByPath["expose.backendPort"]).toBeDefined(); // exceeds maximum
    expect(result.errorsByPath["expose.backendProtocol"]).toBeDefined(); // not in enum
  });
});
