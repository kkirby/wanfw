import { Badge, Card, Stack, Table, TableTbody, TableTd, TableTh, TableThead, TableTr, Text, Title } from "@mantine/core";
import { listCerts } from "../../../lib/orch";
import { StageErrorAlert, UnreachableAlert } from "../../../components/error-alert/ErrorAlert";

export const dynamic = "force-dynamic";

export default async function CertsPage() {
  let error: string | null = null;
  let certs: Awaited<ReturnType<typeof listCerts>> = [];

  try {
    certs = await listCerts();
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  return (
    <Stack>
      <Title order={2}>Certs</Title>
      {error && <UnreachableAlert message={error} />}
      <Card withBorder padding="lg">
        {certs.length === 0 ? (
          <Text c="dimmed" size="sm">
            No certs stored yet.
          </Text>
        ) : (
          <Table>
            <TableThead>
              <TableTr>
                <TableTh>Name</TableTh>
                <TableTh>Covers</TableTh>
                <TableTh>Current generation</TableTh>
                <TableTh>Stored</TableTh>
                <TableTh>Renewal</TableTh>
              </TableTr>
            </TableThead>
            <TableTbody>
              {certs.map((cert) => (
                <TableTr key={cert.name}>
                  <TableTd>{cert.name}</TableTd>
                  <TableTd>{cert.meta?.names.join(", ") ?? "—"}</TableTd>
                  <TableTd>
                    gen-{cert.currentGeneration}
                    <Text component="span" size="xs" c="dimmed" ml={6}>
                      ({cert.generations.length} retained)
                    </Text>
                  </TableTd>
                  <TableTd>{cert.meta?.storedAt ? new Date(cert.meta.storedAt).toLocaleString() : "never"}</TableTd>
                  <TableTd>
                    {cert.renewal.consecutiveFailures > 0 ? (
                      <Badge color="orange">{cert.renewal.consecutiveFailures} failed attempt(s)</Badge>
                    ) : cert.renewal.lastSuccessAt ? (
                      <Badge color="green">last succeeded {new Date(cert.renewal.lastSuccessAt).toLocaleString()}</Badge>
                    ) : (
                      <Badge color="gray">no attempts recorded</Badge>
                    )}
                  </TableTd>
                </TableTr>
              ))}
            </TableTbody>
          </Table>
        )}
      </Card>
      {certs
        .filter((cert) => cert.renewal.lastError)
        .map((cert) => (
          <StageErrorAlert
            key={cert.name}
            title={`Cert '${cert.name}'`}
            error={{ stage: "renewal", message: cert.renewal.lastError!.message }}
          />
        ))}
    </Stack>
  );
}
