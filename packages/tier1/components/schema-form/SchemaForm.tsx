"use client";

import { ActionIcon, Checkbox, Group, NumberInput, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import type { FieldNode, ObjectArrayVariant } from "../../lib/schema-form/types";

export interface SchemaFormProps {
  fields: FieldNode[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  errorsByPath: Record<string, string[]>;
  pathPrefix?: string;
}

function get(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

function set(value: Record<string, unknown>, key: string, next: unknown): Record<string, unknown> {
  return { ...value, [key]: next };
}

function errorFor(errorsByPath: Record<string, string[]>, fullPath: string): string | undefined {
  return errorsByPath[fullPath]?.join(", ");
}

/**
 * JSON Schema (2020-12 subset) -> Mantine form renderer (§5.5/§10.1, T3.13).
 * Walks a field tree already produced by `buildFieldTree`/`buildFieldNode`
 * (pure, unit-tested separately); this component's only job is presenting
 * it and threading value/onChange down. Client-side validation errors
 * (`errorsByPath`, from `validateDocument`) are UX only -- the orchestrator
 * remains the sole authority (§5.5); this never blocks a submit attempt on
 * its own, it only annotates fields.
 */
export function SchemaForm({ fields, value, onChange, errorsByPath, pathPrefix = "" }: SchemaFormProps): React.JSX.Element {
  return (
    <Stack gap="md">
      {fields.map((field) => {
        const fullPath = pathPrefix ? `${pathPrefix}.${field.path}` : field.path;
        const error = errorFor(errorsByPath, fullPath);

        if (field.kind === "string" && field.constValue !== undefined) {
          return null; // discriminator fields are set implicitly, never user-edited
        }

        if (field.kind === "string" && field.enumValues) {
          return (
            <Select
              key={field.path}
              label={field.title}
              description={field.description}
              required={field.required}
              error={error}
              data={field.enumValues}
              value={(get(value, field.path) as string | null) ?? null}
              onChange={(v) => onChange(set(value, field.path, v))}
            />
          );
        }

        if (field.kind === "string") {
          return (
            <TextInput
              key={field.path}
              label={field.title}
              description={field.description}
              required={field.required}
              error={error}
              value={(get(value, field.path) as string) ?? ""}
              onChange={(e) => onChange(set(value, field.path, e.currentTarget.value))}
            />
          );
        }

        if (field.kind === "number" || field.kind === "integer") {
          return (
            <NumberInput
              key={field.path}
              label={field.title}
              description={field.description}
              required={field.required}
              error={error}
              min={field.minimum}
              max={field.maximum}
              value={(get(value, field.path) as number) ?? ""}
              onChange={(v) => onChange(set(value, field.path, v))}
            />
          );
        }

        if (field.kind === "boolean") {
          return (
            <Checkbox
              key={field.path}
              label={field.title}
              description={field.description}
              checked={Boolean(get(value, field.path))}
              onChange={(e) => onChange(set(value, field.path, e.currentTarget.checked))}
            />
          );
        }

        if (field.kind === "array-scalar") {
          const items = (get(value, field.path) as unknown[]) ?? [];
          return (
            <Textarea
              key={field.path}
              label={field.title}
              description={`${field.description ?? ""} (one per line)`.trim()}
              error={error}
              value={items.join("\n")}
              onChange={(e) => {
                const lines = e.currentTarget.value.split("\n").filter((l) => l.trim().length > 0);
                const parsed = field.itemKind === "string" ? lines : lines.map(Number);
                onChange(set(value, field.path, parsed));
              }}
            />
          );
        }

        if (field.kind === "map") {
          const map = (get(value, field.path) as Record<string, string>) ?? {};
          const text = Object.entries(map)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n");
          return (
            <Textarea
              key={field.path}
              label={field.title}
              description={`${field.description ?? ""} (KEY=value, one per line)`.trim()}
              error={error}
              value={text}
              onChange={(e) => {
                const next: Record<string, string> = {};
                for (const line of e.currentTarget.value.split("\n")) {
                  const idx = line.indexOf("=");
                  if (idx > 0) next[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                }
                onChange(set(value, field.path, next));
              }}
            />
          );
        }

        if (field.kind === "object") {
          const nested = (get(value, field.path) as Record<string, unknown>) ?? {};
          return (
            <Stack key={field.path} gap="xs" pl="md" style={{ borderLeft: "2px solid var(--mantine-color-gray-3)" }}>
              <Text fw={600} size="sm">
                {field.title}
              </Text>
              <SchemaForm
                fields={field.fields}
                value={nested}
                errorsByPath={errorsByPath}
                pathPrefix={fullPath}
                onChange={(next) => onChange(set(value, field.path, next))}
              />
            </Stack>
          );
        }

        if (field.kind === "array-object") {
          return (
            <ObjectArrayEditor
              key={field.path}
              field={field.path}
              title={field.title}
              variants={field.variants}
              items={(get(value, field.path) as Record<string, unknown>[]) ?? []}
              errorsByPath={errorsByPath}
              pathPrefix={fullPath}
              onChange={(items) => onChange(set(value, field.path, items))}
            />
          );
        }

        return null;
      })}
    </Stack>
  );
}

interface ObjectArrayEditorProps {
  field: string;
  title: string;
  variants: ObjectArrayVariant[];
  items: Record<string, unknown>[];
  errorsByPath: Record<string, string[]>;
  pathPrefix: string;
  onChange: (items: Record<string, unknown>[]) => void;
}

function ObjectArrayEditor({ title, variants, items, errorsByPath, pathPrefix, onChange }: ObjectArrayEditorProps): React.JSX.Element {
  const isPolymorphic = variants.length > 1;

  function addRow(): void {
    const variant = variants[0]!;
    const row = variant.discriminatorField && variant.discriminatorValue ? { [variant.discriminatorField]: variant.discriminatorValue } : {};
    onChange([...items, row]);
  }

  function removeRow(index: number): void {
    onChange(items.filter((_, i) => i !== index));
  }

  function updateRow(index: number, next: Record<string, unknown>): void {
    onChange(items.map((row, i) => (i === index ? next : row)));
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text fw={600} size="sm">
          {title}
        </Text>
        <ActionIcon variant="light" onClick={addRow} aria-label={`Add ${title} row`}>
          +
        </ActionIcon>
      </Group>
      {items.map((row, index) => {
        const discriminatorField = variants.find((v) => v.discriminatorField)?.discriminatorField;
        const activeVariant =
          (discriminatorField ? variants.find((v) => v.discriminatorValue === row[discriminatorField]) : undefined) ?? variants[0]!;
        return (
          <Group key={index} align="flex-start" gap="xs" wrap="nowrap">
            <Stack gap="xs" style={{ flex: 1 }}>
              {isPolymorphic && discriminatorField && (
                <Select
                  label={discriminatorField}
                  data={variants.map((v) => v.discriminatorValue!).filter(Boolean)}
                  value={String(row[discriminatorField] ?? "")}
                  onChange={(v) => v && updateRow(index, { [discriminatorField]: v })}
                />
              )}
              <SchemaForm
                fields={activeVariant.fields}
                value={row}
                errorsByPath={errorsByPath}
                pathPrefix={`${pathPrefix}.${index}`}
                onChange={(next) => updateRow(index, discriminatorField ? { ...next, [discriminatorField]: row[discriminatorField] } : next)}
              />
            </Stack>
            <ActionIcon variant="light" color="red" onClick={() => removeRow(index)} aria-label={`Remove ${title} row ${index}`}>
              &times;
            </ActionIcon>
          </Group>
        );
      })}
    </Stack>
  );
}
