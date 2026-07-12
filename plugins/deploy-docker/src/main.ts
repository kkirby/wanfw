import { createInterface } from "node:readline";
import { planTask } from "./plan.js";

/**
 * Hand-rolled NDJSON JSON-RPC loop (§6.5/§6.7 framing), not `@wanfw/plugin-sdk`'s
 * `runPlugin`. The pluginhost spawns exactly `node <bundle>/dist/main.js`
 * (ADR-3) with only the bundle's own copied files on disk -- no workspace
 * `node_modules` travels with it -- so the shipped entrypoint must have zero
 * runtime `require`/`import` of anything outside this file and Node's
 * builtins. `plan.ts`'s only `@wanfw/plugin-sdk`/`@wanfw/core-schemas`
 * imports are `import type` (fully erased by tsc), so it stays safe to ship
 * as-is; only the entrypoint needed this workaround. The dev/test-time SDK
 * dependency (`invokePluginForTest`, `runPlugin`'s types) in
 * `index.test.ts` never ships in the bundle.
 */
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  void (async () => {
    let id: unknown;
    try {
      const req = JSON.parse(line) as { id: unknown; method: string; params?: unknown };
      id = req.id;
      if (req.method !== "deploy.plan") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such task: ${req.method}` } })}\n`);
        return;
      }
      const result = await planTask(
        req.params as Parameters<typeof planTask>[0],
        // This plugin makes zero host API calls (ADR-4 item 1: purely
        // declarative), so a real HostApiClient is never constructed.
        undefined as unknown as Parameters<typeof planTask>[1],
      );
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } })}\n`);
    }
  })();
});
