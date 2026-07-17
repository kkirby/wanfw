import { Badge, Card, Stack, Table, TableTbody, TableTd, TableTh, TableThead, TableTr, Text, Title } from "@mantine/core";
import { runDoctorChecks, type DoctorStatus } from "../../../lib/orch";
import { UnreachableAlert } from "../../../components/error-alert/ErrorAlert";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<DoctorStatus, string> = {
  pass: "green",
  fail: "red",
  warn: "yellow",
  info: "gray",
  skip: "gray",
};

export default async function DiagnosticsPage() {
  let error: string | null = null;
  let checks: Awaited<ReturnType<typeof runDoctorChecks>> = [];

  try {
    checks = await runDoctorChecks();
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  return (
    <Stack>
      <Title order={2}>Diagnostics</Title>
      <Text size="sm" c="dimmed">
        Same checks as <code>wanfwctl doctor</code> -- Docker socket, proxy container, network provider, WAN IP vs DNS,
        DNS provider credentials.
      </Text>
      {error && <UnreachableAlert message={error} />}
      <Card withBorder padding="lg">
        {checks.length === 0 ? (
          <Text c="dimmed" size="sm">
            No checks reported.
          </Text>
        ) : (
          <Table>
            <TableThead>
              <TableTr>
                <TableTh>Check</TableTh>
                <TableTh>Status</TableTh>
                <TableTh>Message</TableTh>
              </TableTr>
            </TableThead>
            <TableTbody>
              {checks.map((check) => (
                <TableTr key={check.name}>
                  <TableTd>{check.name}</TableTd>
                  <TableTd>
                    <Badge color={STATUS_COLOR[check.status]}>{check.status}</Badge>
                  </TableTd>
                  <TableTd>{check.message}</TableTd>
                </TableTr>
              ))}
            </TableTbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}
