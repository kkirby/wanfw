"use client";

import { useActionState } from "react";
import { Alert, Button, Container, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { setupAction, type SetupActionState } from "./actions";

const initialState: SetupActionState = {};

export function SetupForm() {
  const [state, formAction, pending] = useActionState(setupAction, initialState);

  return (
    <Container size={420} py={80}>
      <Title order={2} mb="xs">
        wanfw setup
      </Title>
      <Text c="dimmed" mb="lg">
        Enter the setup token printed by <code>wanfwctl init</code> to create the admin account.
      </Text>
      <form action={formAction}>
        <Stack>
          {state?.error && <Alert color="red">{state.error}</Alert>}
          <TextInput name="token" label="Setup token" required autoFocus />
          <PasswordInput name="password" label="Admin password" required />
          <PasswordInput name="confirmPassword" label="Confirm password" required />
          <Button type="submit" loading={pending}>
            Create admin account
          </Button>
        </Stack>
      </form>
    </Container>
  );
}
