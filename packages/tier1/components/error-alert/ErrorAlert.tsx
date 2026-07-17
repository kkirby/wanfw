import { Alert, Badge, Group, Text } from "@mantine/core";

/** Shared phase/status -> color vocabulary (originally services/page.tsx's own PHASE_COLOR) -- kept here so every page reaches for the same colors instead of redefining them locally. */
export const PHASE_COLOR: Record<string, string> = {
  live: "green",
  reconciling: "blue",
  pending: "gray",
  "pending-approval": "yellow",
  degraded: "orange",
  error: "red",
};

export interface StageError {
  stage: string;
  plugin?: string;
  message: string;
}

/** De-duplicates the "orchestrator unreachable" `<Alert>` copy-pasted across every tier1 page's try/catch-on-fetch-failure path. */
export function UnreachableAlert({ message }: { message: string }) {
  return (
    <Alert color="red" title="Orchestrator unreachable">
      {message}
    </Alert>
  );
}

/**
 * Renders a structured backend error ({stage, plugin?, message}) -- unlike
 * the ad-hoc `{error.message}` interpolation used throughout tier1 today,
 * this doesn't discard `stage`/`plugin`, the two fields that say *where*
 * the problem is, not just what it is.
 */
export function StageErrorAlert({ error, color }: { error: StageError; color?: string }) {
  return (
    <Alert color={color ?? PHASE_COLOR.degraded} title="Degraded">
      <Group gap="xs" mb={4}>
        <Badge color={color ?? PHASE_COLOR.degraded} variant="light">
          {error.stage}
        </Badge>
        {error.plugin && (
          <Badge color="gray" variant="light">
            {error.plugin}
          </Badge>
        )}
      </Group>
      <Text size="sm">{error.message}</Text>
    </Alert>
  );
}
