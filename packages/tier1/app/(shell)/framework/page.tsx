import { Card, Group, Stack, Table, TableTbody, TableTd, TableTr, Text, Title } from "@mantine/core";
import { getFramework } from "../../../lib/orch";
import { UnreachableAlert } from "../../../components/error-alert/ErrorAlert";

export const dynamic = "force-dynamic";

function row(label: string, value: string | undefined) {
  return (
    <TableTr key={label}>
      <TableTd>
        <Text fw={500} size="sm">
          {label}
        </Text>
      </TableTd>
      <TableTd>{value ?? "—"}</TableTd>
    </TableTr>
  );
}

export default async function FrameworkPage() {
  let error: string | null = null;
  let framework: Awaited<ReturnType<typeof getFramework>>;

  try {
    framework = await getFramework();
  } catch (err) {
    error = `could not reach the orchestrator: ${(err as Error).message}`;
  }

  return (
    <Stack>
      <Title order={2}>Framework</Title>
      {error && <UnreachableAlert message={error} />}
      {!error && !framework && (
        <Text c="dimmed" size="sm">
          No framework document set yet -- run <code>wanfwctl init</code>.
        </Text>
      )}
      {framework && (
        <>
          <Card withBorder padding="lg">
            <Table>
              <TableTbody>
                {row("Domain", framework.domain)}
                {row("Deployment mode", framework.deploymentMode)}
                {row("ACME email", framework.acmeEmail)}
                {row("Strict approvals", framework.strictApprovals ?? "powerful")}
              </TableTbody>
            </Table>
          </Card>
          <Card withBorder padding="lg">
            <Group mb="sm">
              <Text fw={600}>Roles</Text>
            </Group>
            <Table>
              <TableTbody>
                {row("Network provider", framework.roles.networkProvider)}
                {row("Proxy engine", framework.roles.proxyEngine)}
                {row("Cert issuer", framework.roles.certIssuer)}
                {row("DNS provider", framework.roles.dnsProvider)}
              </TableTbody>
            </Table>
          </Card>
          {framework.network && (
            <Card withBorder padding="lg">
              <Group mb="sm">
                <Text fw={600}>Network</Text>
              </Group>
              <Table>
                <TableTbody>
                  {row("LAN interface", framework.network.lanInterface)}
                  {framework.network.macvlan && (
                    <>
                      {row("Macvlan parent", framework.network.macvlan.parent)}
                      {row("Reserved CIDR", framework.network.macvlan.reservedCidr)}
                      {row("Gateway", framework.network.macvlan.gateway)}
                    </>
                  )}
                </TableTbody>
              </Table>
            </Card>
          )}
        </>
      )}
    </Stack>
  );
}
