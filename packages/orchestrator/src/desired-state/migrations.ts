import type { JsonValue } from "@wanfw/core-schemas";

/** Current core document schema version. Bump when a core migration is added. */
export const CURRENT_SCHEMA_VERSION = 1;

export class DocumentTooNewError extends Error {
  constructor(
    public readonly kind: string,
    public readonly id: string,
    public readonly foundVersion: number,
  ) {
    super(
      `document ${kind}/${id} has schemaVersion ${foundVersion}, newer than this orchestrator knows (${CURRENT_SCHEMA_VERSION}). Upgrade the framework.`,
    );
  }
}

export type MigrationFn = (spec: Record<string, JsonValue>) => Record<string, JsonValue>;

/**
 * Core migration functions n -> n+1. Identity chain for now (v1 is the
 * only version); real migrations land here as schemaVersion is bumped.
 * Keyed by the version being migrated FROM.
 */
export const CORE_MIGRATIONS: Record<number, MigrationFn> = {
  // 1: (spec) => ({ ...spec }),  // example shape for a future v1 -> v2 migration
};

export interface MigrationResult {
  spec: Record<string, JsonValue>;
  finalVersion: number;
  /** Present when the in-memory spec is ahead of what's persisted on disk. */
  needsPersist?: { toVersion: number };
}

/**
 * Migrates a document's spec in memory from its on-disk schemaVersion to
 * CURRENT_SCHEMA_VERSION. Never writes back to wanfw_desired (invariant
 * #10) -- the write-back protocol (§5.6) is: flag needsPersist, tier1
 * fetches the migrated document over the status socket and persists it
 * with its own atomic write.
 */
export function migrateDocumentSpec(
  kind: string,
  id: string,
  schemaVersion: number,
  spec: Record<string, JsonValue>,
): MigrationResult {
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new DocumentTooNewError(kind, id, schemaVersion);
  }

  let currentVersion = schemaVersion;
  let currentSpec = spec;
  while (currentVersion < CURRENT_SCHEMA_VERSION) {
    const migrate = CORE_MIGRATIONS[currentVersion];
    if (!migrate) break; // no migration registered for this hop; stop where we are
    currentSpec = migrate(currentSpec);
    currentVersion += 1;
  }

  if (currentVersion === schemaVersion) {
    return { spec: currentSpec, finalVersion: currentVersion };
  }
  return { spec: currentSpec, finalVersion: currentVersion, needsPersist: { toVersion: currentVersion } };
}
