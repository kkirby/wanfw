import "@mantine/core/styles.css";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { ColorSchemeScript } from "@mantine/core";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "wanfw",
  description: "wanfw control plane",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The CSP is nonce-based with no 'unsafe-inline' on style-src-elem/script-src
  // (middleware.ts). Mantine injects a runtime <style> tag carrying its
  // AppShell/theme CSS variables and a <script> for the color scheme -- both
  // need this same nonce or the browser drops them, which is what was
  // silently zeroing out --app-shell-header-offset/--app-shell-navbar-offset
  // and making the header/navbar overlap the page content.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en">
      <head>
        <ColorSchemeScript nonce={nonce} />
      </head>
      <body>
        <Providers nonce={nonce}>{children}</Providers>
      </body>
    </html>
  );
}
