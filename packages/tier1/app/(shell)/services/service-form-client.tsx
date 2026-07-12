"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Group, TextInput } from "@mantine/core";
import { useRouter } from "next/navigation";
import { SchemaForm } from "../../../components/schema-form/SchemaForm";
import type { FieldNode } from "../../../lib/schema-form/types";
import { saveServiceAction } from "./actions";

export interface ServiceFormClientProps {
  serviceId?: string; // undefined = create; id is immutable once set
  fields: FieldNode[];
  initialDisplayName?: string;
  initialSpec: Record<string, unknown>;
}

export function ServiceFormClient({ serviceId, fields, initialDisplayName, initialSpec }: ServiceFormClientProps) {
  const router = useRouter();
  const [id, setId] = useState(serviceId ?? "");
  const [displayName, setDisplayName] = useState(initialDisplayName ?? "");
  const [spec, setSpec] = useState<Record<string, unknown>>(initialSpec);
  const [errorsByPath, setErrorsByPath] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(): void {
    setFormError(null);
    startTransition(async () => {
      const result = await saveServiceAction(id, displayName, spec);
      if (!result.ok) {
        setErrorsByPath(result.errorsByPath ?? {});
        setFormError(result.formError ?? "validation failed -- see field errors below");
        return;
      }
      router.push("/services");
    });
  }

  return (
    <>
      {formError && (
        <Alert color="red" title="Could not save" mb="md">
          {formError}
        </Alert>
      )}
      <TextInput
        label="Service ID"
        description="Lowercase alphanumeric + hyphens; used in container/network names. Cannot be changed after creation."
        required
        disabled={Boolean(serviceId)}
        value={id}
        onChange={(e) => setId(e.currentTarget.value)}
        mb="md"
      />
      <TextInput label="Display name" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} mb="md" />
      <SchemaForm fields={fields} value={spec} onChange={setSpec} errorsByPath={errorsByPath} />
      <Group mt="lg">
        <Button onClick={submit} loading={pending} disabled={!id}>
          Save
        </Button>
      </Group>
    </>
  );
}
