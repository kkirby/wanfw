import { createInterface } from "node:readline";
import { probeTask } from "./probe.js";
import { planTask } from "./plan.js";
import type { EndpointRequest, ProbeContext } from "./types.js";

/**
 * Hand-rolled NDJSON JSON-RPC loop, same reasoning as deploy-docker's
 * main.ts (T3.10): the pluginhost spawns this bundle with no node_modules
 * alongside it, so the shipped entrypoint imports only Node builtins and
 * its own compiled siblings.
 */
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let id: unknown;
  try {
    const req = JSON.parse(line) as { id: unknown; method: string; params?: unknown };
    id = req.id;
    if (req.method === "network.probe") {
      const result = probeTask(req.params as ProbeContext);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      return;
    }
    if (req.method === "network.plan") {
      const result = planTask(req.params as EndpointRequest);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such task: ${req.method}` } })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } })}\n`);
  }
});
