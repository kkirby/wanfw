import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_SCHEMAS, atomicWriteFile, type JsonValue } from "@wanfw/core-schemas";
import type { StateStore } from "../state-store/store.js";

export interface ComposedSchema {
  envelope: JsonValue;
  framework: JsonValue;
  /** Core service schema with spec.deploy's anchor merged from the bound deploy plugin's configSchema, if any. */
  service: JsonValue;
  /** Per-plugin configSchema, keyed by plugin id, mounted at the plugins/<id>.json spec anchor (§5.5). */
  pluginConfigSchemas: Record<string, JsonValue>;
  /** Which plugin (if any) is currently supplying the spec.deploy anchor. */
  boundDeployPluginId?: string;
}

interface ManifestLike {
  id: string;
  types: string[];
  configSchema?: string;
}

async function readManifest(bundleDir: string): Promise<ManifestLike | undefined> {
  try {
    const raw = await readFile(join(bundleDir, "manifest.json"), "utf8");
    return JSON.parse(raw) as ManifestLike;
  } catch {
    return undefined;
  }
}

async function readConfigSchema(bundleDir: string, relPath: string): Promise<JsonValue | undefined> {
  try {
    const raw = await readFile(join(bundleDir, relPath), "utf8");
    return JSON.parse(raw) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Builds the effective schema = core + each enabled plugin's configSchema
 * mounted at its documented anchor (§5.5): spec.deploy for the bound
 * deploy-type plugin (v1 ships exactly one, so "bound" = the one trusted
 * deploy-type plugin; if more than one is ever trusted, the lowest plugin
 * id wins deterministically rather than erroring, since this is a display/
 * validation-UX concern, not a security one -- the orchestrator's real
 * authority is still the core anchor plus per-field capability checks).
 */
export async function buildComposedSchema(store: StateStore, bundlesDir: string): Promise<ComposedSchema> {
  const trusted = store.listTrustRecords();
  const pluginConfigSchemas: Record<string, JsonValue> = {};
  let boundDeployPluginId: string | undefined;
  let deployConfigSchema: JsonValue | undefined;

  const deployCandidates: string[] = [];

  for (const record of trusted) {
    const bundleDir = join(bundlesDir, record.sha256);
    const manifest = await readManifest(bundleDir);
    if (!manifest || !manifest.configSchema) continue;

    const schema = await readConfigSchema(bundleDir, manifest.configSchema);
    if (!schema) continue;

    pluginConfigSchemas[manifest.id] = schema;
    if (manifest.types.includes("deploy")) {
      deployCandidates.push(manifest.id);
    }
  }

  if (deployCandidates.length > 0) {
    boundDeployPluginId = [...deployCandidates].sort()[0];
    deployConfigSchema = pluginConfigSchemas[boundDeployPluginId!];
  }

  const serviceSchema = structuredClone(CORE_SCHEMAS.service) as {
    properties: { deploy: { properties?: Record<string, JsonValue>; additionalProperties?: boolean } };
  };

  if (deployConfigSchema && typeof deployConfigSchema === "object" && "properties" in deployConfigSchema) {
    const deploySchemaProps = (deployConfigSchema as { properties?: Record<string, JsonValue> }).properties ?? {};
    serviceSchema.properties.deploy = {
      ...serviceSchema.properties.deploy,
      properties: { plugin: { type: "string" }, ...deploySchemaProps },
    };
  }

  return {
    envelope: CORE_SCHEMAS.envelope,
    framework: CORE_SCHEMAS.framework,
    service: serviceSchema as unknown as JsonValue,
    pluginConfigSchemas,
    boundDeployPluginId,
  };
}

/** Republishes the composed schema to wanfw_status/schema.json (§5.5: "after every plugin-set change"). */
export async function publishComposedSchema(
  store: StateStore,
  bundlesDir: string,
  statusDir: string,
): Promise<ComposedSchema> {
  const composed = await buildComposedSchema(store, bundlesDir);
  await atomicWriteFile(join(statusDir, "schema.json"), JSON.stringify(composed, null, 2), { mode: 0o644 });
  return composed;
}
