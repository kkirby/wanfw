"use client";

import { MantineProvider } from "@mantine/core";

export function Providers({ nonce, children }: { nonce?: string; children: React.ReactNode }) {
  return (
    <MantineProvider defaultColorScheme="auto" getStyleNonce={() => nonce ?? ""}>
      {children}
    </MantineProvider>
  );
}
