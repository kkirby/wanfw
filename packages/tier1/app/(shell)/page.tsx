import { Card, Stack, Text, Title } from "@mantine/core";
import { getFrameworkStatus, listServiceStatuses } from "../../lib/orch";
import { StatusPoller } from "./status-poller";
import { StageErrorAlert, UnreachableAlert } from "../../components/error-alert/ErrorAlert";

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

  // A framework-wide degraded phase (shown by StatusPoller below) doesn't
  // say *which* service is affected -- this surfaces that per-service, from
  // the same status docs the Services list already discards this data from.
  const serviceStatuses = error ? [] : await listServiceStatuses();
  const flagged = serviceStatuses.filter((s) => s.lastError || s.phase === "degraded" || s.phase === "error");

  return (
    <Stack>
      <Title order={2}>Dashboard</Title>
      {error && <UnreachableAlert message={error} />}
      {flagged.map((s) => (
        <StageErrorAlert
          key={s.serviceId}
          title={`Service '${s.serviceId}'`}
          color={s.phase === "error" ? "red" : "orange"}
          error={s.lastError ?? { stage: "unknown", message: `service '${s.serviceId}' is ${s.phase}` }}
        />
      ))}
      <Card withBorder padding="lg">
        <Text fw={600} mb="xs">
          Framework status
        </Text>
        <StatusPoller initialStatus={initialStatus} />
      </Card>
    </Stack>
  );
}
