import { createInterface } from "node:readline";
import { probeTask } from "./probe.js";
import { planTask } from "./plan.js";
import type { EndpointRequest, ProbeContext } from "./types.js";

/**
 * Hand-rolled NDJSON JSON-RPC loop, same shape as every other v1 plugin's
 * entrypoint. Unlike `network-bridge`, this one needs real `host.call`
 * round trips: `net.probeNetwork` (probe-time feasibility) and
 * `ipam.allocate` (plan-time static IP).
 */
let nextHostCallId = 1;
const pendingHostCalls = new Map<string, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();

function callHost(method: string, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `host-${nextHostCallId++}`;
    pendingHostCalls.set(id, { resolve, reject });
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "host.call", params: { method, args } })}\n`);
  });
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  void (async () => {
    let id: unknown;
    try {
      const msg = JSON.parse(line) as { id: unknown; method?: string; params?: unknown; result?: unknown; error?: unknown };

      if (msg.method === undefined && typeof msg.id === "string" && pendingHostCalls.has(msg.id)) {
        const pending = pendingHostCalls.get(msg.id)!;
        pendingHostCalls.delete(msg.id);
        if (msg.error !== undefined) {
          pending.reject(new Error((msg.error as { message?: string }).message ?? "host call failed"));
        } else {
          pending.resolve(msg.result);
        }
        return;
      }

      id = msg.id;
      if (msg.method === "network.probe") {
        const result = await probeTask(msg.params as ProbeContext, async (mode, parent) => {
          return (await callHost("net.probeNetwork", { mode, parent })) as { ok: boolean; reason?: string };
        });
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
        return;
      }
      if (msg.method === "network.plan") {
        // `parent`/`reservedCidr`/`gateway` ride alongside the ADR-1-typed
        // EndpointRequest fields in the same flat args object (PLAN stage
        // merges them in from `framework.spec.network.macvlan`, since
        // ADR-1's own `EndpointRequest` interface is deliberately
        // provider-agnostic) -- not a wrapper object, so this stays a
        // structural superset of what `network-bridge` receives, not a
        // divergent shape.
        const { parent, reservedCidr, gateway, ...req } = msg.params as EndpointRequest & {
          parent: string;
          reservedCidr: string;
          gateway: string;
        };
        const result = await planTask(req, parent, reservedCidr, gateway, async () => {
          // `owner: req.purpose` makes this idempotent across repeated
          // plans for the same logical resource (PLAN re-runs on every
          // reconcile, ~every 60s) -- without it, every single call minted
          // a brand-new address and never released the previous one,
          // silently leaking the reserved range dry over time. `purpose`
          // is exactly the stable identity `stableAddress: true` already
          // promised but never actually implemented.
          const res = (await callHost("ipam.allocate", { rangeId: "macvlan", owner: req.purpose })) as { ip: string };
          return res.ip;
        });
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such task: ${msg.method}` } })}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } })}\n`);
    }
  })();
});
