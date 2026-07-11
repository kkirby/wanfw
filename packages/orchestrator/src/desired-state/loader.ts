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

async function loadOneDocument(path: string): Promise<{ doc?: LoadedDocument; error?: DocumentError }> {
  let raw: unknown;
  try {
    const text = await readFile(path, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    return { error: { sourcePath: path, message: `could not read/parse: ${(err as Error).message}` } };
  }

  if (!validators.envelope(raw)) {
    const details = (validators.envelope.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return { error: { sourcePath: path, message: `envelope invalid: ${details}` } };
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
    return { error: { sourcePath: path, message: `spec invalid: ${details}` } };
  }

  let migration: MigrationResult;
  try {
    migration = migrateDocumentSpec(envelope.kind, envelope.metadata.id, envelope.schemaVersion, envelope.spec);
  } catch (err) {
    if (err instanceof DocumentTooNewError) {
      return { error: { sourcePath: path, message: err.message } };
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
      sourcePath: path,
    },
  };
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => join(dir, e.name));
}

/** Loads and validates every document currently in wanfw_desired. Never writes to it (invariant #10). */
export async function loadDesiredState(desiredDir: string): Promise<DesiredState> {
  const state: DesiredState = { services: new Map(), pluginConfigs: new Map(), errors: [] };

  const frameworkPath = join(desiredDir, "framework.json");
  const frameworkResult = await loadOneDocument(frameworkPath).catch(() => undefined);
  if (frameworkResult?.doc) state.framework = frameworkResult.doc;
  else if (frameworkResult?.error && !frameworkResult.error.message.includes("could not read/parse")) {
    state.errors.push(frameworkResult.error);
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
