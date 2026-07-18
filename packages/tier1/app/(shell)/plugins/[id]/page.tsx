import { Badge, Card, Code, Group, Stack, Table, TableTbody, TableTd, TableTh, TableThead, TableTr, Text, Title } from "@mantine/core";
import { getTrustedPlugin } from "../../../../lib/orch";
import { UnreachableAlert } from "../../../../components/error-alert/ErrorAlert";

export const dynamic = "force-dynamic";

export default async function PluginDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let error: string | null = null;
  let data: Awaited<ReturnType<typeof getTrustedPlugin>>;

  try {
    data = await getTrustedPlugin(id);
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  return (
    <Stack>
      <Title order={2}>Plugin: {id}</Title>
      {error && <UnreachableAlert message={error} />}
      {!error && !data && (
        <Text c="dimmed" size="sm">
          No trusted plugin named &quot;{id}&quot;.
        </Text>
      )}
      {data && (
        <>
          <Card withBorder padding="lg">
            <Text fw={600} mb="sm">
              Trust history
            </Text>
            <Table>
              <TableThead>
                <TableTr>
                  <TableTh>Version</TableTh>
                  <TableTh>Hash</TableTh>
                  <TableTh>Trusted at</TableTh>
                  <TableTh>Status</TableTh>
                </TableTr>
              </TableThead>
              <TableTbody>
                {data.trusted.map((t) => (
                  <TableTr key={`${t.plugin_id}@${t.version}@${t.sha256}`}>
                    <TableTd>{t.version}</TableTd>
                    <TableTd>
                      <Code>{t.sha256.slice(0, 12)}…</Code>
                    </TableTd>
                    <TableTd>{new Date(t.created_at).toLocaleString()}</TableTd>
                    <TableTd>
                      {t.revoked_at ? (
                        <Badge color="red">revoked {new Date(t.revoked_at).toLocaleDateString()}</Badge>
                      ) : (
                        <Badge color="green">active</Badge>
                      )}
                    </TableTd>
                  </TableTr>
                ))}
              </TableTbody>
            </Table>
          </Card>

          <Card withBorder padding="lg">
            <Text fw={600} mb="sm">
              Granted capability scopes
            </Text>
            {data.grants.length === 0 ? (
              <Text c="dimmed" size="sm">
                No capability grants recorded for this plugin.
              </Text>
            ) : (
              <Stack gap="sm">
                {data.grants
                  .filter((g) => !g.revoked_at)
                  .map((g) => (
                    <Group key={g.id} align="flex-start" gap="xs">
                      <Badge variant="light">{g.cap}</Badge>
                      <Code>{JSON.stringify(JSON.parse(g.scope_json))}</Code>
                    </Group>
                  ))}
              </Stack>
            )}
          </Card>
        </>
      )}
    </Stack>
  );
}
