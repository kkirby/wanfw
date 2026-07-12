import type {
  FieldNode,
  JsonSchemaLike,
  ObjectArrayVariant,
} from "./types.js";

function titleFor(key: string, schema: JsonSchemaLike): string {
  return schema.title ?? key;
}

function isMapSchema(schema: JsonSchemaLike): boolean {
  return (
    schema.type === "object" &&
    !schema.properties &&
    typeof schema.additionalProperties === "object" &&
    schema.additionalProperties?.type === "string"
  );
}

function buildVariant(schema: JsonSchemaLike, discriminatorField: string): ObjectArrayVariant {
  const discriminatorValue = schema.properties?.[discriminatorField]?.const as string | undefined;
  const fields = Object.entries(schema.properties ?? {})
    .filter(([key]) => key !== discriminatorField)
    .map(([key, sub]) => buildFieldNode(key, sub, `${key}`, (schema.required ?? []).includes(key)));
  return { discriminatorValue, discriminatorField, fields };
}

/**
 * Walks a JSON Schema (2020-12 subset per the plan: string/number/integer/
 * boolean, enum, const, arrays of scalars and of objects incl. oneOf
 * polymorphism, nested objects, additionalProperties string maps, required,
 * defaults, title/description) into a renderer-agnostic field tree. Pure
 * function -- no React, no DOM -- so it's unit-testable directly against
 * real plugin config-schema fixtures (§5.5's own composition contract).
 */
export function buildFieldNode(key: string, schema: JsonSchemaLike, path: string, required: boolean): FieldNode {
  const base = {
    path,
    title: titleFor(key, schema),
    description: schema.description,
    required,
    default: schema.default,
  };

  if (schema.const !== undefined) {
    return { ...base, kind: "string", constValue: String(schema.const) };
  }

  if (schema.enum) {
    return { ...base, kind: "string", enumValues: schema.enum.map(String) };
  }

  if (schema.type === "boolean") {
    return { ...base, kind: "boolean" };
  }

  if (schema.type === "number" || schema.type === "integer") {
    return { ...base, kind: schema.type, minimum: schema.minimum, maximum: schema.maximum };
  }

  if (schema.type === "array") {
    const items = schema.items;
    if (items?.oneOf) {
      const discriminatorField = "type"; // convention used by every v1 polymorphic array (deploy-docker's mounts)
      return { ...base, kind: "array-object", variants: items.oneOf.map((v) => buildVariant(v, discriminatorField)) };
    }
    if (items?.type === "object") {
      return { ...base, kind: "array-object", variants: [{ fields: buildObjectFields(items) }] };
    }
    return { ...base, kind: "array-scalar", itemKind: (items?.type as "string" | "number" | "integer") ?? "string" };
  }

  if (schema.type === "object") {
    if (isMapSchema(schema)) {
      return { ...base, kind: "map", valueKind: "string" };
    }
    return { ...base, kind: "object", fields: buildObjectFields(schema) };
  }

  // Default: plain string (covers untyped/free-text schema fragments).
  return { ...base, kind: "string" };
}

function buildObjectFields(schema: JsonSchemaLike): FieldNode[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([key, sub]) => buildFieldNode(key, sub, key, required.has(key)));
}

/** Entry point: builds the top-level field list for a whole schema object (e.g. the composed service schema). */
export function buildFieldTree(schema: JsonSchemaLike): FieldNode[] {
  return buildObjectFields(schema);
}
