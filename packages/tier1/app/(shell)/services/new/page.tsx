import { Alert, Stack, Title } from "@mantine/core";
import { getComposedSchema } from "../../../../lib/orch";
import { buildFieldTree } from "../../../../lib/schema-form/build-field-tree";
import type { JsonSchemaLike } from "../../../../lib/schema-form/types";
import { ServiceFormClient } from "../service-form-client";

export const dynamic = "force-dynamic";

export default async function NewServicePage() {
  const composed = await getComposedSchema();
  if (!composed) {
    return (
      <Stack>
        <Title order={2}>Add service</Title>
        <Alert color="red" title="Orchestrator unreachable">
          Could not fetch the composed schema.
        </Alert>
      </Stack>
    );
  }
  if (!composed.boundDeployPluginId) {
    return (
      <Stack>
        <Title order={2}>Add service</Title>
        <Alert color="yellow" title="No deploy plugin bound">
          Trust a deploy-type plugin (e.g. deploy-docker) before adding a service.
        </Alert>
      </Stack>
    );
  }

  // "deploy.plugin" is filled in server-side from the bound deploy plugin
  // (§10.1) -- never operator-editable, so it's dropped from the rendered tree.
  const fields = buildFieldTree(composed.service as JsonSchemaLike).map((f) =>
    f.path === "deploy" && f.kind === "object" ? { ...f, fields: f.fields.filter((sub) => sub.path !== "plugin") } : f,
  );

  return (
    <Stack>
      <Title order={2}>Add service</Title>
      <ServiceFormClient fields={fields} initialSpec={{}} />
    </Stack>
  );
}
