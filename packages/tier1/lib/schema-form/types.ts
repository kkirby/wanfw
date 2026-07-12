/** JSON Schema (2020-12 subset, §5.5/§10.1) -> field-tree node shapes the renderer walks. */

export interface BaseField {
  path: string; // dot-path into the document, e.g. "deploy.mounts.0.target"
  title: string;
  description?: string;
  required: boolean;
  default?: unknown;
}

export interface StringField extends BaseField {
  kind: "string";
  enumValues?: string[];
  constValue?: string;
}

export interface NumberField extends BaseField {
  kind: "number" | "integer";
  minimum?: number;
  maximum?: number;
}

export interface BooleanField extends BaseField {
  kind: "boolean";
}

export interface ScalarArrayField extends BaseField {
  kind: "array-scalar";
  itemKind: "string" | "number" | "integer";
}

export interface ObjectField extends BaseField {
  kind: "object";
  fields: FieldNode[];
}

/** Array of objects, optionally polymorphic via a oneOf discriminated by a `const` field (e.g. deploy-docker's mounts: volume | bind). */
export interface ObjectArrayField extends BaseField {
  kind: "array-object";
  variants: ObjectArrayVariant[];
}

export interface ObjectArrayVariant {
  /** The const value of the discriminator field that selects this variant, if the array is oneOf-polymorphic; undefined for a single non-polymorphic item schema. */
  discriminatorValue?: string;
  discriminatorField?: string;
  fields: FieldNode[];
}

/** A map-shaped object (`additionalProperties: {type: "string"}`, e.g. env/labels) rendered as free-form key/value rows rather than a fixed field set. */
export interface MapField extends BaseField {
  kind: "map";
  valueKind: "string";
}

export type FieldNode = StringField | NumberField | BooleanField | ScalarArrayField | ObjectField | ObjectArrayField | MapField;

export interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchemaLike;
  oneOf?: JsonSchemaLike[];
  additionalProperties?: JsonSchemaLike | boolean;
  minimum?: number;
  maximum?: number;
}
