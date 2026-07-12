import { createAjv } from "@wanfw/core-schemas";
import type { JsonSchemaLike } from "./types.js";

export interface FormValidationResult {
  valid: boolean;
  errorsByPath: Record<string, string[]>;
}

/**
 * Validates a draft document against a JSON Schema (typically the composed
 * schema's `service` anchor from `wanfw_status/schema.json`) and maps Ajv's
 * `instancePath`s (e.g. "/deploy/mounts/0/target") to the renderer's own
 * dot-path convention (e.g. "deploy.mounts.0.target") so field-level error
 * display is a simple lookup. Client-side validation is UX only (§5.5) --
 * the orchestrator's own `POST /validate` (T3.2) remains authoritative;
 * this exists purely to surface errors on the right fields before submit.
 */
export function validateDocument(schema: JsonSchemaLike, data: unknown): FormValidationResult {
  // A fresh Ajv instance per call: the composed schema (§5.5) is assembled
  // dynamically per request and may carry the same $id across calls (it's
  // cloned from the static core service schema), which a shared/cached Ajv
  // registry would reject as a duplicate on the second compile.
  const validateFn = createAjv().compile(schema as object);
  const valid = validateFn(data);
  const errorsByPath: Record<string, string[]> = {};
  if (!valid) {
    for (const err of validateFn.errors ?? []) {
      const path = err.instancePath.replace(/^\//, "").replace(/\//g, ".") || "(root)";
      errorsByPath[path] ??= [];
      errorsByPath[path].push(err.message ?? "invalid");
    }
  }
  return { valid: Boolean(valid), errorsByPath };
}
