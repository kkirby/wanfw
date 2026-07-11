import { Alert, Card, Stack, Text, Title } from "@mantine/core";
import { getFrameworkStatus } from "../../lib/orch";
import { StatusPoller } from "./status-poller";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let initialStatus: unknown = null;
  let error: string | null = null;

  try {
    const res = await getFrameworkStatus();
    if (res.status === 200) {
      initialStatus = res.body;
    } else {
      error = `orchestrator returned ${res.status}`;
    }
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  return (
    <Stack>
      <Title order={2}>Dashboard</Title>
      {error && (
        <Alert color="red" title="Orchestrator unreachable">
          {error}
        </Alert>
      )}
      <Card withBorder padding="lg">
        <Text fw={600} mb="xs">
          Framework status
        </Text>
        <StatusPoller initialStatus={initialStatus} />
      </Card>
    </Stack>
  );
}
