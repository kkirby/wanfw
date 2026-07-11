/**
 * Canonical JSON serialization: object keys sorted lexicographically (recursively).
 * Arrays are NOT reordered by default -- array order is semantically meaningful
 * unless a caller explicitly sorts an array before passing it in (spec callers
 * that need sorted arrays, e.g. the powerful projection, sort at the call site).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out: { [key: string]: JsonValue } = {};
    for (const key of sortedKeys) {
      out[key] = canonicalize((value as { [key: string]: JsonValue })[key] as JsonValue);
    }
    return out;
  }
  return value;
}

/** Sorted-keys, unicode-stable JSON.stringify with no extra whitespace. */
export function canonicalJSONStringify(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}
