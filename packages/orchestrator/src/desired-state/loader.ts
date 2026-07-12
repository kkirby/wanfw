import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { compileCoreValidators, type JsonValue } from "@wanfw/core-schemas";
import { migrateDocumentSpec, DocumentTooNewError, type MigrationResult } from "./migrations.js";

export interface LoadedDocument {
  kind: "Framework" | "Service" | "PluginConfig";
  id: string;
  displayName?: string;
  spec: Record<string, JsonValue>;
  schemaVersion: number;
  needsPersist?: { toVersion: number };
  sourcePath: string;
}

export interface DocumentError {
  sourcePath: string;
  message: string;
}

export interface DesiredState {
  framework?: LoadedDocument;
  services: Map<string, LoadedDocument>;
  pluginConfigs: Map<string, LoadedDocument>;
  errors: DocumentError[];
}

const validators = compileCoreValidators();

function kindValidator(kind: string) {
  if (kind === "Framework") return validators.framework;
  if (kind === "Service") return validators.service;
  if (kind === "PluginConfig") return validators.pluginConfig;
  return undefined;
}

/**
 * Validates+migrates an already-parsed envelope object, independent of
 * where it came from -- a file under `wanfw_desired` (services, plugin
 * configs) or, since T5.3's framework-doc relocation, the state store
 * (`StateStore.getFrameworkDoc`/admin-socket `POST /framework`, which
 * reuses this exact function so a bad framework doc is rejected at write
 * time with the same message the file loader would have produced).
 */
export function validateEnvelope(raw: unknown, sourcePath: string): { doc?: LoadedDocument; error?: DocumentError } {
  if (!validators.envelope(raw)) {
    const details = (validators.envelope.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return { error: { sourcePath, message: `envelope invalid: ${details}` } };
  }

  const envelope = raw as {
    kind: "Framework" | "Service" | "PluginConfig";
    schemaVersion: number;
    metadata: { id: string; displayName?: string };
    spec: Record<string, JsonValue>;
  };

  const specValidator = kindValidator(envelope.kind);
  if (specValidator && !specValidator(envelope.spec)) {
    const details = (specValidator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return { error: { sourcePath, message: `spec invalid: ${details}` } };
  }

  let migration: MigrationResult;
  try {
    migration = migrateDocumentSpec(envelope.kind, envelope.metadata.id, envelope.schemaVersion, envelope.spec);
  } catch (err) {
    if (err instanceof DocumentTooNewError) {
      return { error: { sourcePath, message: err.message } };
    }
    throw err;
  }

  return {
    doc: {
      kind: envelope.kind,
      id: envelope.metadata.id,
      displayName: envelope.metadata.displayName,
      spec: migration.spec,
      schemaVersion: migration.finalVersion,
      needsPersist: migration.needsPersist,
      sourcePath,
    },
  };
}

async function loadOneDocument(path: string): Promise<{ doc?: LoadedDocument; error?: DocumentError }> {
  let raw: unknown;
  try {
    const text = await readFile(path, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    return { error: { sourcePath: path, message: `could not read/parse: ${(err as Error).message}` } };
  }
  return validateEnvelope(raw, path);
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => join(dir, e.name));
}

/**
 * Loads and validates every document currently in wanfw_desired. Never
 * writes to it (invariant #10). The framework document is no longer one of
 * them (T5.3): it lives in `wanfw_state`, authored only via the admin
 * socket's `POST /framework` (see `docs/t5.3-decisions.md`), and is passed
 * in here already-loaded (or `undefined` pre-init) by the caller
 * (`buildLoadStage`, which reads it from `StateStore.getFrameworkDoc`) --
 * `loadDesiredState` only ever validates it, via the same `validateEnvelope`
 * the write path already ran it through once, so a framework doc that made
 * it into the store can't fail differently on load than it did on write.
 */
export async function loadDesiredState(desiredDir: string, frameworkRaw?: unknown): Promise<DesiredState> {
  const state: DesiredState = { services: new Map(), pluginConfigs: new Map(), errors: [] };

  if (frameworkRaw !== undefined) {
    const frameworkResult = validateEnvelope(frameworkRaw, "wanfw_state:framework");
    if (frameworkResult.doc) state.framework = frameworkResult.doc;
    else if (frameworkResult.error) state.errors.push(frameworkResult.error);
  }

  const serviceFiles = await listJsonFiles(join(desiredDir, "services"));
  for (const path of serviceFiles) {
    const result = await loadOneDocument(path);
    if (result.doc) state.services.set(result.doc.id, result.doc);
    else if (result.error) state.errors.push(result.error);
  }

  const pluginFiles = await listJsonFiles(join(desiredDir, "plugins"));
  for (const path of pluginFiles) {
    const result = await loadOneDocument(path);
    if (result.doc) state.pluginConfigs.set(result.doc.id, result.doc);
    else if (result.error) state.errors.push(result.error);
  }

  return state;
}
