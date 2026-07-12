import { Alert, Badge, Card, Code, Stack, Text, Title } from "@mantine/core";
import { listGatedPlans } from "../../../lib/orch";

export const dynamic = "force-dynamic";

/**
 * Approvals (ADR-6): read-only. Every gated plan shows its human-rendered
 * projection and the exact copyable `wanfwctl plan approve` command --
 * there is no approve button anywhere in tier1, ever. Approval only ever
 * happens via the CLI, which requires host Docker-exec rights (the correct
 * trust bar per ADR-6's own reasoning).
 */
export default async function ApprovalsPage() {
  let error: string | null = null;
  let plans: Awaited<ReturnType<typeof listGatedPlans>> = [];

  try {
    plans = await listGatedPlans();
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  const pending = plans.filter((p) => !p.approved);

  return (
    <Stack>
      <Title order={2}>Approvals</Title>
      {error && (
        <Alert color="red" title="Orchestrator unreachable">
          {error}
        </Alert>
      )}
      {pending.length === 0 ? (
        <Card withBorder padding="lg">
          <Text c="dimmed" size="sm">
            No plans are currently parked pending approval.
          </Text>
        </Card>
      ) : (
        <Stack gap="md">
          {pending.map((plan) => (
            <Card key={plan.projectionHash} withBorder padding="lg">
              <Stack gap="xs">
                <Text fw={600}>
                  {plan.serviceId} <Badge color="yellow">pending approval</Badge>
                </Text>
                <Text size="sm">{plan.humanRendering}</Text>
                <Text size="sm" fw={600} mt="sm">
                  Run on the host to approve:
                </Text>
                <Code block>{`wanfwctl plan approve --service ${plan.serviceId}`}</Code>
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
