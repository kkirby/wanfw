import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAjv } from "./validators.js";
import manifestSchema from "./schemas/manifest.schema.json" with { type: "json" };
import type { JsonValue } from "./canonical-json.js";

/** Current framework capability-surface version. Bump on breaking host-API changes. */
export const FRAMEWORK_API_VERSION = "1.0.0";

export type PluginType = "deploy" | "network-provider" | "proxy-engine" | "cert-issuer" | "dns-provider";

export interface ManifestCapability {
  cap: string;
  scope: Record<string, JsonValue>;
  reason: string;
  enforcement?: "enforced" | "declared";
}

export interface ManifestDependencies {
  settings?: Record<string, JsonValue>;
  roles?: string[];
  plugins?: string[];
}

export interface Manifest {
  manifestVersion: 1;
  id: string;
  version: string;
  frameworkApi: string;
  types: PluginType[];
  entrypoint: string;
  runtime: "node22";
  configSchema?: string;
  migrations?: string;
  capabilities: ManifestCapability[];
  dependencies?: ManifestDependencies;
}

export interface ManifestLoadResult {
  valid: boolean;
  manifest?: Manifest;
  errors: string[];
}

const manifestValidator = createAjv().compile<Manifest>(manifestSchema);

/** Validates a raw parsed manifest object against the schema. */
export function validateManifest(raw: unknown): ManifestLoadResult {
  const valid = manifestValidator(raw);
  if (!valid) {
    const errors = (manifestValidator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
    return { valid: false, errors };
  }
  return { valid: true, manifest: raw as Manifest, errors: [] };
}

/** Loads and validates `<bundleDir>/manifest.json`. */
export async function loadManifest(bundleDir: string): Promise<ManifestLoadResult> {
  let raw: unknown;
  try {
    const text = await readFile(join(bundleDir, "manifest.json"), "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    return { valid: false, errors: [`could not read manifest.json: ${(err as Error).message}`] };
  }
  return validateManifest(raw);
}

/**
 * `frameworkApi` is a caret range, e.g. "^1.0" or "^1.2.3": compatible with
 * any framework version with the same major, and (minor.patch) >= the
 * range's minor.patch. This is deliberately a small hand-rolled subset of
 * semver caret-range semantics -- exactly what the manifest format uses,
 * nothing more.
 */
export function isFrameworkApiCompatible(range: string, frameworkVersion: string = FRAMEWORK_API_VERSION): boolean {
  const match = /^\^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range);
  if (!match) return false;
  const [, rMajorStr, rMinorStr, rPatchStr] = match;
  const rMajor = Number(rMajorStr);
  const rMinor = Number(rMinorStr);
  const rPatch = rPatchStr !== undefined ? Number(rPatchStr) : 0;

  const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(frameworkVersion);
  if (!versionMatch) return false;
  const [, vMajorStr, vMinorStr, vPatchStr] = versionMatch;
  const vMajor = Number(vMajorStr);
  const vMinor = Number(vMinorStr);
  const vPatch = Number(vPatchStr);

  if (vMajor !== rMajor) return false;
  if (vMinor !== rMinor) return vMinor > rMinor;
  return vPatch >= rPatch;
}

export interface ScopeTemplateContext {
  framework: {
    domain: string;
  };
}

/**
 * Resolves `${framework.domain}`-style templates inside a scope object at
 * grant time (spec §6.2 note). Only string leaf values are scanned; the
 * *resolved* scope is what gets recorded and signed, never the template.
 */
export function resolveScopeTemplates<T extends JsonValue>(scope: T, context: ScopeTemplateContext): T {
  if (typeof scope === "string") {
    return scope.replace(/\$\{framework\.domain\}/g, context.framework.domain) as T;
  }
  if (Array.isArray(scope)) {
    return scope.map((v) => resolveScopeTemplates(v, context)) as T;
  }
  if (scope !== null && typeof scope === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(scope)) {
      out[key] = resolveScopeTemplates(value as JsonValue, context);
    }
    return out as T;
  }
  return scope;
}
