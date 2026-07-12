import { Alert, Badge, Button, Card, Group, Stack, Table, TableTbody, TableTd, TableTh, TableThead, TableTr, Text, Title } from "@mantine/core";
import Link from "next/link";
import { listServiceStatuses } from "../../../lib/orch";
import { listServiceIds, readServiceDoc } from "../../../lib/desired-write";

export const dynamic = "force-dynamic";

const PHASE_COLOR: Record<string, string> = {
  live: "green",
  reconciling: "blue",
  pending: "gray",
  "pending-approval": "yellow",
  degraded: "orange",
  error: "red",
};

export default async function ServicesPage() {
  let error: string | null = null;
  let rows: Array<{ id: string; displayName?: string; hostname?: string; phase: string; needsPersist?: boolean }> = [];

  try {
    const [ids, statuses] = await Promise.all([listServiceIds(), listServiceStatuses()]);
    const statusById = new Map(statuses.map((s) => [s.serviceId, s]));
    const docs = await Promise.all(ids.map((id) => readServiceDoc(id)));
    rows = ids.map((id, i) => {
      const doc = docs[i];
      const expose = doc?.spec.expose as { hostname?: string } | undefined;
      return {
        id,
        displayName: doc?.metadata.displayName,
        hostname: expose?.hostname,
        phase: statusById.get(id)?.phase ?? "pending",
        needsPersist: Boolean(statusById.get(id)?.needsPersist),
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
      {error && (
        <Alert color="red" title="Orchestrator unreachable">
          {error}
        </Alert>
      )}
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
    </Stack>
  );
}
