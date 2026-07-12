import { createInterface } from "node:readline";
import { renderTask } from "./render.js";
import type { RenderInput } from "./types.js";

/** Hand-rolled NDJSON JSON-RPC loop -- same reasoning as deploy-docker/network-bridge (T3.10/T3.11). */
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let id: unknown;
  try {
    const req = JSON.parse(line) as { id: unknown; method: string; params?: unknown };
    id = req.id;
    if (req.method !== "proxy.render") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such task: ${req.method}` } })}\n`);
      return;
    }
    const result = renderTask(req.params as RenderInput);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } })}\n`);
  }
});
