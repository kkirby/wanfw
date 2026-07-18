import { Badge, Card, Code, Stack, Table, TableTbody, TableTd, TableTh, TableThead, TableTr, Text, Title } from "@mantine/core";
import { listAuditEntries } from "../../../lib/orch";
import { UnreachableAlert } from "../../../components/error-alert/ErrorAlert";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  let error: string | null = null;
  let entries: Awaited<ReturnType<typeof listAuditEntries>> = [];

  try {
    entries = await listAuditEntries();
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  // Newest first -- append order on disk is chronological.
  const rows = [...entries].reverse();

  return (
    <Stack>
      <Title order={2}>Audit log</Title>
      <Text size="sm" c="dimmed">
        Read-only. Chain verification (<code>wanfwctl audit tail --verify</code>) is CLI-only.
      </Text>
      {error && <UnreachableAlert message={error} />}
      <Card withBorder padding="lg">
        {rows.length === 0 ? (
          <Text c="dimmed" size="sm">
            No audit entries yet.
          </Text>
        ) : (
          <Table>
            <TableThead>
              <TableTr>
                <TableTh>Seq</TableTh>
                <TableTh>Time</TableTh>
                <TableTh>Type</TableTh>
                <TableTh>Details</TableTh>
              </TableTr>
            </TableThead>
            <TableTbody>
              {rows.map((entry) => (
                <TableTr key={entry.seq}>
                  <TableTd>{entry.seq}</TableTd>
                  <TableTd>{new Date(entry.ts).toLocaleString()}</TableTd>
                  <TableTd>
                    <Badge variant="light">{entry.type}</Badge>
                    {entry.checkpointSig && (
                      <Badge ml={4} size="xs" color="grape" title="Security-relevant: checkpointed and signed">
                        checkpointed
                      </Badge>
                    )}
                  </TableTd>
                  <TableTd>
                    <Code>{JSON.stringify(entry.details)}</Code>
                  </TableTd>
                </TableTr>
              ))}
            </TableTbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}
