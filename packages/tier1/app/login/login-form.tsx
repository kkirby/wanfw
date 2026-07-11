"use client";

import { useActionState } from "react";
import { Alert, Button, Container, PasswordInput, Stack, Title } from "@mantine/core";
import { loginAction, type LoginActionState } from "./actions";

const initialState: LoginActionState = {};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <Container size={420} py={80}>
      <Title order={2} mb="lg">
        wanfw
      </Title>
      <form action={formAction}>
        <Stack>
          {state?.error && <Alert color="red">{state.error}</Alert>}
          <PasswordInput name="password" label="Admin password" required autoFocus />
          <Button type="submit" loading={pending}>
            Log in
          </Button>
        </Stack>
      </form>
    </Container>
  );
}
