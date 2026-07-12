import { Alert, Card, Code, Stack, Table, TableTbody, TableTd, TableTh, TableThead, TableTr, Text, Title } from "@mantine/core";
import { listSecrets } from "../../../lib/orch";

export const dynamic = "force-dynamic";

/**
 * Secrets (§12.4, T4.1): read-only, names + last-rotated only -- values
 * never traverse tier1 at all (they're injected by value into a plugin
 * invocation directly from the orchestrator, never via this UI). Set/unset
 * is CLI-only (`wanfwctl secret set/unset <name>`), same no-mutation-button
 * pattern as the approvals page (ADR-6): tier1 shows state, never accepts
 * a secret value anywhere.
 */
export default async function SecretsPage() {
  let error: string | null = null;
  let secrets: Awaited<ReturnType<typeof listSecrets>> = [];

  try {
    secrets = await listSecrets();
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  return (
    <Stack>
      <Title order={2}>Secrets</Title>
      {error && (
        <Alert color="red" title="Orchestrator unreachable">
          {error}
        </Alert>
      )}
      <Card withBorder padding="lg">
        {secrets.length === 0 ? (
          <Text c="dimmed" size="sm">
            No secrets are set. Use <Code>wanfwctl secret set &lt;plugin&gt;/&lt;name&gt;</Code> on the host.
          </Text>
        ) : (
          <Table>
            <TableThead>
              <TableTr>
                <TableTh>Name</TableTh>
                <TableTh>Last rotated</TableTh>
              </TableTr>
            </TableThead>
            <TableTbody>
              {secrets.map((s) => (
                <TableTr key={s.name}>
                  <TableTd>
                    <Code>{s.name}</Code>
                  </TableTd>
                  <TableTd>{new Date(s.lastRotated).toLocaleString()}</TableTd>
                </TableTr>
              ))}
            </TableTbody>
          </Table>
        )}
      </Card>
      <Card withBorder padding="lg">
        <Text fw={600} mb="sm">
          Set or rotate a secret
        </Text>
        <Text size="sm" c="dimmed" mb="xs">
          Values are never entered here -- piped via stdin on the host only, so they never traverse this UI or its logs:
        </Text>
        <Code block>{`echo -n 'VALUE' | wanfwctl secret set <plugin>/<name>`}</Code>
      </Card>
    </Stack>
  );
}
