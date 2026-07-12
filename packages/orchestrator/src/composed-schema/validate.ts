import { createAjv, type JsonValue } from "@wanfw/core-schemas";
import type { ComposedSchema } from "./compose.js";

export interface ValidateResult {
  valid: boolean;
  errors: string[];
}

/**
 * Pure function: validates a draft document against the composed schema.
 * No side effects, no state mutation -- this backs the status socket's
 * POST /validate (§5.5), which must remain a pure function per the T1.2
 * contract test. Ajv instances are cheap to recompile per call; this isn't
 * called often enough (tier1 UX validation) to warrant caching complexity.
 */
export function validateDraftDocument(composed: ComposedSchema, draft: unknown): ValidateResult {
  const ajv = createAjv();

  if (typeof draft !== "object" || draft === null) {
    return { valid: false, errors: ["document must be a JSON object"] };
  }

  const envelopeValidator = ajv.compile(composed.envelope as object);
  if (!envelopeValidator(draft)) {
    return {
      valid: false,
      errors: (envelopeValidator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`),
    };
  }

  const doc = draft as { kind: string; spec: JsonValue };
  const specSchema =
    doc.kind === "Framework" ? composed.framework : doc.kind === "Service" ? composed.service : undefined;

  if (!specSchema) {
    // PluginConfig: validated against the per-plugin schema at its own anchor.
    return { valid: true, errors: [] };
  }

  const specValidator = ajv.compile(specSchema as object);
  if (!specValidator(doc.spec)) {
    return {
      valid: false,
      errors: (specValidator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`),
    };
  }

  return { valid: true, errors: [] };
}
