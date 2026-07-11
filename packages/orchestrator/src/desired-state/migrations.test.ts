import { describe, expect, it } from "vitest";
import { migrateDocumentSpec, DocumentTooNewError, CURRENT_SCHEMA_VERSION } from "./migrations.js";

describe("migrateDocumentSpec", () => {
  it("returns the spec unchanged with no needsPersist when already current", () => {
    const spec = { a: 1 };
    const result = migrateDocumentSpec("Service", "svc1", CURRENT_SCHEMA_VERSION, spec);
    expect(result.spec).toEqual(spec);
    expect(result.finalVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.needsPersist).toBeUndefined();
  });

  it("throws DocumentTooNewError for a schemaVersion newer than known", () => {
    expect(() => migrateDocumentSpec("Service", "svc1", CURRENT_SCHEMA_VERSION + 1, {})).toThrow(
      DocumentTooNewError,
    );
  });

  it("the too-new error names the exact document kind/id", () => {
    try {
      migrateDocumentSpec("Service", "jellyfin", 99, {});
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/jellyfin/);
      expect((err as Error).message).toMatch(/99/);
    }
  });
});
