"use client";

import { useEffect, useState } from "react";
import { Code, Stack, Text } from "@mantine/core";
import { StageErrorAlert } from "../../components/error-alert/ErrorAlert";

interface FrameworkStatus {
  phase?: string;
  lastError?: { stage: string; plugin?: string; message: string };
}

export function StatusPoller({ initialStatus }: { initialStatus: unknown }) {
  const [status, setStatus] = useState(initialStatus);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (res.ok) {
          setStatus(await res.json());
        }
      } catch {
        // transient poll failure; keep showing last-known status
      }
    };
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, []);

  const framework = status as FrameworkStatus | null;

  return (
    <Stack>
      {framework?.phase === "degraded" &&
        (framework.lastError ? (
          <StageErrorAlert error={framework.lastError} color="orange" />
        ) : (
          <StageErrorAlert error={{ stage: "unknown", message: "the framework reports a degraded state" }} color="orange" />
        ))}
      {/* Native <details> rather than Mantine's Spoiler: needs no client JS
          to work at all, so it can't silently fail to render its toggle. */}
      <details>
        <summary>
          <Text component="span" size="sm" c="dimmed">
            Raw status
          </Text>
        </summary>
        <Code block>{JSON.stringify(status, null, 2)}</Code>
      </details>
    </Stack>
  );
}
