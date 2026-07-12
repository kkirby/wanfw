"use client";

import { useEffect, useState } from "react";
import { Alert, Code, Stack } from "@mantine/core";

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
      {framework?.phase === "degraded" && (
        <Alert color="orange" title="Framework degraded">
          {framework.lastError?.message ?? "the framework reports a degraded state"}
        </Alert>
      )}
      <Code block>{JSON.stringify(status, null, 2)}</Code>
    </Stack>
  );
}
