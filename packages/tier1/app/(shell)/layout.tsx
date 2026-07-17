"use client";

import { AppShell, Group, NavLink, Title } from "@mantine/core";
import Link from "next/link";
import { LogoutButton } from "./logout-button";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/services", label: "Services" },
  { href: "/certs", label: "Certs" },
  { href: "/framework", label: "Framework" },
  { href: "/plugins", label: "Plugins" },
  { href: "/approvals", label: "Approvals" },
  { href: "/secrets", label: "Secrets" },
  { href: "/audit", label: "Audit log" },
  { href: "/instructions", label: "Setup instructions" },
];

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: "sm" }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Title order={4}>wanfw</Title>
          <LogoutButton />
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} component={Link} href={item.href} label={item.label} />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
