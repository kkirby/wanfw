import { Alert, Badge, Card, Group, Stack, Text, Title } from "@mantine/core";
import { getComposedSchema, getServiceStatus } from "../../../../lib/orch";
import { readServiceDoc } from "../../../../lib/desired-write";
import { buildFieldTree } from "../../../../lib/schema-form/build-field-tree";
import type { JsonSchemaLike } from "../../../../lib/schema-form/types";
import { ServiceFormClient } from "../service-form-client";
import { DeleteServiceButton } from "./delete-button";
import { PHASE_COLOR, StageErrorAlert } from "../../../../components/error-alert/ErrorAlert";

export const dynamic = "force-dynamic";

export default async function EditServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [composed, doc, status] = await Promise.all([getComposedSchema(), readServiceDoc(id), getServiceStatus(id)]);

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
      {status && (
        <Card withBorder padding="lg">
          <Group gap="xs" mb={status.lastError ? "sm" : 0}>
            <Badge color={PHASE_COLOR[status.phase] ?? "gray"}>{status.phase}</Badge>
            {status.endpoints.map((endpoint) => (
              <Text key={endpoint} size="sm" c="dimmed">
                {endpoint}
              </Text>
            ))}
            {status.certNotAfter && (
              <Text size="sm" c="dimmed">
                cert expires {new Date(status.certNotAfter).toLocaleDateString()}
              </Text>
            )}
          </Group>
          {status.lastError && <StageErrorAlert error={status.lastError} color={status.phase === "error" ? "red" : "orange"} />}
        </Card>
      )}
      <ServiceFormClient
        serviceId={id}
        fields={fields}
        initialDisplayName={doc.metadata.displayName}
        initialSpec={doc.spec}
      />
    </Stack>
  );
}
