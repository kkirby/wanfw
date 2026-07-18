import { Alert, Badge, Button, Card, Code, Group, Stack, Table, TableTbody, TableTd, TableTh, TableThead, TableTr, Text, Title } from "@mantine/core";
import Link from "next/link";
import { listPendingPlugins, listTrustedPlugins } from "../../../lib/orch";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

export default async function PluginsPage() {
  let trusted: Awaited<ReturnType<typeof listTrustedPlugins>> = [];
  let pending: Awaited<ReturnType<typeof listPendingPlugins>> = [];
  let error: string | null = null;

  try {
    [trusted, pending] = await Promise.all([listTrustedPlugins(), listPendingPlugins()]);
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  return (
    <Stack>
      <Title order={2}>Plugins</Title>
      {error && (
        <Alert color="red" title="Orchestrator unreachable">
          {error}
        </Alert>
      )}

      <Card withBorder padding="lg">
        <Text fw={600} mb="sm">
          Installed / trusted
        </Text>
        {trusted.length === 0 ? (
          <Text c="dimmed" size="sm">
            No plugins are currently trusted.
          </Text>
        ) : (
          <Table>
            <TableThead>
              <TableTr>
                <TableTh>Plugin</TableTh>
                <TableTh>Version</TableTh>
                <TableTh>Hash</TableTh>
                <TableTh>Granted capabilities</TableTh>
                <TableTh />
              </TableTr>
            </TableThead>
            <TableTbody>
              {trusted.map((t) => {
                const caps = JSON.parse(t.granted_caps_json) as string[];
                return (
                  <TableTr key={`${t.plugin_id}@${t.version}`}>
                    <TableTd>{t.plugin_id}</TableTd>
                    <TableTd>{t.version}</TableTd>
                    <TableTd>
                      <Code>{t.sha256.slice(0, 12)}…</Code>
                    </TableTd>
                    <TableTd>
                      <Group gap={4}>
                        {caps.map((c) => (
                          <Badge key={c} size="sm" variant="light">
                            {c}
                          </Badge>
                        ))}
                      </Group>
                    </TableTd>
                    <TableTd>
                      <Button component={Link} href={`/plugins/${encodeURIComponent(t.plugin_id)}`} variant="light" size="xs">
                        Details
                      </Button>
                    </TableTd>
                  </TableTr>
                );
              })}
            </TableTbody>
          </Table>
        )}
      </Card>

      <Card withBorder padding="lg">
        <Text fw={600} mb="sm">
          Pending trust
        </Text>
        {pending.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing staged. Upload a plugin bundle below.
          </Text>
        ) : (
          <Stack gap="md">
            {pending.map((bundle) => (
              <Card key={bundle.dirName} withBorder padding="sm" bg="var(--mantine-color-yellow-light)">
                <Text fw={600}>{bundle.manifest?.id ?? bundle.dirName}</Text>
                {bundle.manifestErrors ? (
                  <Alert color="red" title="Invalid manifest" mt="xs">
                    {bundle.manifestErrors.join("; ")}
                  </Alert>
                ) : (
                  <>
                    <Text size="sm" c="dimmed">
                      version {bundle.manifest?.version} — hash {bundle.sha256}
                    </Text>
                    {bundle.manifest?.capabilities && bundle.manifest.capabilities.length > 0 && (
                      <Stack gap={2} mt="xs">
                        {bundle.manifest.capabilities.map((c) => (
                          <Text key={c.cap} size="sm">
                            <Code>{c.cap}</Code> — {c.reason}
                          </Text>
                        ))}
                      </Stack>
                    )}
                    <Text size="sm" fw={600} mt="sm">
                      Run on the host to trust this plugin:
                    </Text>
                    <Code block mt={4}>
                      {`wanfwctl plugin trust ${bundle.manifest?.id ?? bundle.dirName}@${bundle.sha256} --yes`}
                    </Code>
                  </>
                )}
              </Card>
            ))}
          </Stack>
        )}
      </Card>

      <Card withBorder padding="lg">
        <Text fw={600} mb="sm">
          Upload a plugin bundle
        </Text>
        <UploadForm />
      </Card>
    </Stack>
  );
}
