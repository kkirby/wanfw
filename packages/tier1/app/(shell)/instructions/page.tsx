import { Alert, Card, Code, List, ListItem, Stack, Text, Title } from "@mantine/core";
import { getOperatorInfo } from "../../../lib/orch";

export const dynamic = "force-dynamic";

/**
 * Operator instructions (T5.5): a read-only mirror of `wanfwctl init`'s
 * own "Next steps" output (DNS record, port-forward target, WAN IP) --
 * written once by the wizard via admin.sock (`POST /operator-info`),
 * read here via the status socket, same "write on admin.sock, mirror on
 * status-socket" split as every other tier1 read path (secrets, plugins,
 * plans). Exists so the operator isn't relying on terminal scrollback
 * from whenever `wanfwctl init` happened to run.
 */
export default async function InstructionsPage() {
  let error: string | null = null;
  let info: Awaited<ReturnType<typeof getOperatorInfo>>;

  try {
    info = await getOperatorInfo();
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  return (
    <Stack>
      <Title order={2}>Setup instructions</Title>
      {error && (
        <Alert color="red" title="Orchestrator unreachable">
          {error}
        </Alert>
      )}
      <Card withBorder padding="lg">
        {!info ? (
          <Text c="dimmed" size="sm">
            No setup instructions yet. Run <Code>wanfwctl init</Code> on the host.
          </Text>
        ) : (
          <Stack gap="xs">
            <Text size="sm">
              Domain: <Code>{info.domain}</Code>
            </Text>
            <Text size="sm">Network provider: {info.networkProvider}</Text>
            <Text size="sm">WAN IP: {info.wanIp ?? "could not be detected -- check it yourself"}</Text>
            <List size="sm" mt="sm">
              {info.instructions.map((line, i) => (
                <ListItem key={i}>{line}</ListItem>
              ))}
            </List>
            <Text size="xs" c="dimmed" mt="sm">
              Generated {new Date(info.generatedAt).toLocaleString()} -- re-run <Code>wanfwctl init</Code> to refresh.
            </Text>
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
