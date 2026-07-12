import { createInterface } from "node:readline";
import { get as httpsGet } from "node:https";
import { applyDnsRecord, type DnsApplyInput } from "./apply.js";
import type { FetchFn, NamecheapConfig } from "./namecheap-client.js";

/**
 * Hand-rolled NDJSON JSON-RPC loop -- same reasoning as every other v1
 * plugin's entrypoint (T3.10/T3.11/T3.12): the pluginhost spawns this
 * bundle with no node_modules alongside it. This plugin additionally needs
 * a real outbound `host.call` round trip (for `secrets.get`, since the API
 * credentials are never passed in the task input -- they live in
 * `wanfw_secrets/dns-namecheap/*`, this plugin's own granted namespace)
 * layered on top of the usual request/response framing.
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

async function getSecret(name: string): Promise<string> {
  const res = (await callHost("secrets.get", { name })) as { value: string | null };
  if (!res.value) throw new Error(`missing required secret '${name}' -- set it with: wanfwctl secret set ${name}`);
  return res.value;
}

/**
 * `node:https` directly, deliberately not the global `fetch()`: Node's
 * `fetch` routes through undici's WASM-compiled llhttp parser, and that
 * WASM instance reserves several GB of *virtual* address space up front
 * (guard-page bounds-checking, unrelated to actual memory used) --
 * completely incompatible with `prlimit --as` (ADR-3's per-invocation
 * sandbox, ../pluginhost/src/child-runner.ts), which caps virtual address
 * space, not resident memory. Discovered live (T4.2): the very first
 * `fetch()` call crashed the child with a native
 * `RangeError: WebAssembly.instantiate(): Out of memory` even at an 8GB
 * `--as` ceiling. `node:https` is the classic (non-WASM) client and stays
 * well within the original T2.9 floor. Every future plugin needing
 * outbound HTTP under this sandbox must do the same -- documented here as
 * the load-bearing reason, not just a style choice.
 */
function httpGet(url: string): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, text: async () => body });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function loadConfig(): Promise<NamecheapConfig> {
  const apiUser = await getSecret("dns-namecheap/api-user");
  const username = await getSecret("dns-namecheap/username");
  const apiKey = await getSecret("dns-namecheap/api-key");
  const ipRes = await httpGet("https://api.ipify.org?format=json");
  const { ip } = JSON.parse(await ipRes.text()) as { ip: string };
  return { apiUser, username, apiKey, clientIp: ip };
}

const realFetch: FetchFn = httpGet;

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  void (async () => {
    let id: unknown;
    try {
      const msg = JSON.parse(line) as { id: unknown; method?: string; params?: unknown; result?: unknown; error?: unknown };

      // Response to a host.call this plugin itself issued. A denied/failed
      // call (e.g. no covering secrets.read grant) arrives as {id, error},
      // not {id, result: undefined} -- treating it as success here would
      // silently smuggle a capability-denial into a null-valued "value",
      // which is exactly the class of bug that undermines the whole
      // capability model, so it's rejected explicitly, not left implicit.
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
      if (msg.method !== "dns.apply") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such task: ${msg.method}` } })}\n`);
        return;
      }
      const config = await loadConfig();
      const result = await applyDnsRecord(realFetch, config, msg.params as DnsApplyInput);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } })}\n`);
    }
  })();
});
