import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    alias: {
      // "server-only" throws by design when imported outside Next's
      // react-server bundling condition; tests run under plain Node, so
      // stub it to a no-op here (Next.js itself still enforces the real
      // guard at build time via its own resolver).
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
});
