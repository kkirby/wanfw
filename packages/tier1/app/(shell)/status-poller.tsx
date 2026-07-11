"use client";

import { useEffect, useState } from "react";
import { Code } from "@mantine/core";

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

  return <Code block>{JSON.stringify(status, null, 2)}</Code>;
}
