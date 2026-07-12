import { Alert, Group, Stack, Title } from "@mantine/core";
import { getComposedSchema } from "../../../../lib/orch";
import { readServiceDoc } from "../../../../lib/desired-write";
import { buildFieldTree } from "../../../../lib/schema-form/build-field-tree";
import type { JsonSchemaLike } from "../../../../lib/schema-form/types";
import { ServiceFormClient } from "../service-form-client";
import { DeleteServiceButton } from "./delete-button";

export const dynamic = "force-dynamic";

export default async function EditServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [composed, doc] = await Promise.all([getComposedSchema(), readServiceDoc(id)]);

  if (!doc) {
    return (
      <Stack>
        <Title order={2}>Edit service</Title>
        <Alert color="red" title="Not found">
          No service document for &quot;{id}&quot;.
        </Alert>
      </Stack>
    );
  }
  if (!composed) {
    return (
      <Stack>
        <Title order={2}>Edit service</Title>
        <Alert color="red" title="Orchestrator unreachable">
          Could not fetch the composed schema.
        </Alert>
      </Stack>
    );
  }

  const fields = buildFieldTree(composed.service as JsonSchemaLike).map((f) =>
    f.path === "deploy" && f.kind === "object" ? { ...f, fields: f.fields.filter((sub) => sub.path !== "plugin") } : f,
  );

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Edit service: {doc.metadata.displayName ?? id}</Title>
        <DeleteServiceButton id={id} />
      </Group>
      <ServiceFormClient
        serviceId={id}
        fields={fields}
        initialDisplayName={doc.metadata.displayName}
        initialSpec={doc.spec}
      />
    </Stack>
  );
}
