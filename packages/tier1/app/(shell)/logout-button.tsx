"use client";

import { Button } from "@mantine/core";
import { logoutAction } from "./actions";

export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <Button type="submit" variant="subtle" size="xs">
        Log out
      </Button>
    </form>
  );
}
