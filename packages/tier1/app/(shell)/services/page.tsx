import { Badge, Button, Card, Group, Stack, Table, TableTbody, TableTd, TableTh, TableThead, TableTr, Text, Title } from "@mantine/core";
import Link from "next/link";
import { listServiceStatuses, type ServiceStatusDoc } from "../../../lib/orch";
import { listServiceIds, readServiceDoc } from "../../../lib/desired-write";
import { PHASE_COLOR, StageErrorAlert, UnreachableAlert } from "../../../components/error-alert/ErrorAlert";

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  let error: string | null = null;
  let rows: Array<{
    id: string;
    displayName?: string;
    hostname?: string;
    phase: string;
    needsPersist?: boolean;
    certNotAfter: ServiceStatusDoc["certNotAfter"] | null;
    lastError?: ServiceStatusDoc["lastError"];
  }> = [];

  try {
    const [ids, statuses] = await Promise.all([listServiceIds(), listServiceStatuses()]);
    const statusById = new Map(statuses.map((s) => [s.serviceId, s]));
    const docs = await Promise.all(ids.map((id) => readServiceDoc(id)));
    rows = ids.map((id, i) => {
      const doc = docs[i];
      const expose = doc?.spec.expose as { hostname?: string } | undefined;
      const status = statusById.get(id);
      return {
        id,
        displayName: doc?.metadata.displayName,
        hostname: expose?.hostname,
        phase: status?.phase ?? "pending",
        needsPersist: Boolean(status?.needsPersist),
        certNotAfter: status?.certNotAfter ?? null,
        lastError: status?.lastError,
      };
    });
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Services</Title>
        <Button component={Link} href="/services/new">
          Add service
        </Button>
      </Group>
      {error && <UnreachableAlert message={error} />}
      <Card withBorder padding="lg">
        {rows.length === 0 ? (
          <Text c="dimmed" size="sm">
            No services yet.
          </Text>
        ) : (
          <Table>
            <TableThead>
              <TableTr>
                <TableTh>Service</TableTh>
                <TableTh>Hostname</TableTh>
                <TableTh>Phase</TableTh>
                <TableTh>Cert expires</TableTh>
                <TableTh />
              </TableTr>
            </TableThead>
            <TableTbody>
              {rows.map((row) => (
                <TableTr key={row.id}>
                  <TableTd>
                    {row.displayName ?? row.id}
                    {row.needsPersist && (
                      <Badge ml={6} size="xs" color="grape" title="Schema migrated in memory; edit and re-save to persist">
                        needs persist
                      </Badge>
                    )}
                  </TableTd>
                  <TableTd>{row.hostname ?? "—"}</TableTd>
                  <TableTd>
                    <Badge color={PHASE_COLOR[row.phase] ?? "gray"}>{row.phase}</Badge>
                  </TableTd>
                  <TableTd>
                    {row.certNotAfter ? new Date(row.certNotAfter).toLocaleDateString() : "—"}
                  </TableTd>
                  <TableTd>
                    <Button component={Link} href={`/services/${row.id}`} variant="light" size="xs">
                      Edit
                    </Button>
                  </TableTd>
                </TableTr>
              ))}
            </TableTbody>
          </Table>
        )}
      </Card>
      {rows
        .filter((row) => row.lastError)
        .map((row) => (
          <StageErrorAlert
            key={row.id}
            title={`Service '${row.displayName ?? row.id}'`}
            color={row.phase === "error" ? "red" : "orange"}
            error={row.lastError!}
          />
        ))}
    </Stack>
  );
}
