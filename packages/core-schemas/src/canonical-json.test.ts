import { describe, expect, it } from "vitest";
import { canonicalJSONStringify } from "./canonical-json.js";

describe("canonicalJSONStringify", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalJSONStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested object keys recursively", () => {
    expect(canonicalJSONStringify({ z: { d: 1, c: 2 }, a: 1 })).toBe(
      '{"a":1,"z":{"c":2,"d":1}}',
    );
  });

  it("preserves array element order (arrays are not reordered)", () => {
    expect(canonicalJSONStringify({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("canonicalizes objects nested inside arrays", () => {
    expect(canonicalJSONStringify({ a: [{ b: 1, a: 2 }] })).toBe('{"a":[{"a":2,"b":1}]}');
  });

  it("is stable across different input key orders (order independence)", () => {
    const first = canonicalJSONStringify({ a: 1, b: 2, c: 3 });
    const second = canonicalJSONStringify({ c: 3, b: 2, a: 1 });
    expect(first).toBe(second);
  });

  it("round-trips unicode content byte-for-byte", () => {
    const out = canonicalJSONStringify({ name: "jellyfin é東京" });
    expect(JSON.parse(out)).toEqual({ name: "jellyfin é東京" });
  });

  it("handles empty objects and arrays", () => {
    expect(canonicalJSONStringify({})).toBe("{}");
    expect(canonicalJSONStringify({ a: [] })).toBe('{"a":[]}');
  });

  it("handles null and primitive values", () => {
    expect(canonicalJSONStringify(null)).toBe("null");
    expect(canonicalJSONStringify({ a: null, b: true, c: 1.5 })).toBe(
      '{"a":null,"b":true,"c":1.5}',
    );
  });
});
