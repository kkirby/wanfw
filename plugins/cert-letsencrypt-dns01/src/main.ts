import { createInterface } from "node:readline";
import { request as httpsRequest } from "node:https";
import { resolveTxt as dnsResolveTxt } from "node:dns/promises";
import { certEnsure, type CertEnsureDeps, type CertEnsureInput, type DnsRecord } from "./cert-ensure.js";
import type { AcmeHttpFn } from "./acme-client.js";

/**
 * Hand-rolled NDJSON JSON-RPC loop, same reasoning and same nested-host.call
 * bridging pattern as T4.2's dns-namecheap plugin: the pluginhost spawns
 * this bundle with no node_modules, and every outbound call -- to the ACME
 * server, and to the orchestrator's host API for secrets/DNS/cert storage
 * -- uses `node:https`/`node:dns` directly, never the global `fetch()`
 * (T4.2's WASM/`prlimit --as` discovery: `fetch()`'s WASM-compiled HTTP
 * parser reserves several GB of virtual address space regardless of
 * actual usage, incompatible with this sandbox).
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

const httpFn: AcmeHttpFn = (method, url, body) => {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method, headers: body ? { "content-type": "application/jose+json", "content-length": Buffer.byteLength(body) } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
};

const deps: CertEnsureDeps = {
  http: httpFn,
  directoryUrl: process.env.WANFW_ACME_DIRECTORY_URL ?? "https://acme-v02.api.letsencrypt.org/directory",
  secretsGet: async (name) => (await callHost("secrets.get", { name }) as { value: string | null }).value,
  secretsPut: async (name, value) => {
    await callHost("secrets.put", { name, value });
  },
  dnsSetRecord: async (zone, record: DnsRecord) => {
    await callHost("dns.setRecord", { zone, record });
  },
  dnsDeleteRecord: async (zone, record: DnsRecord) => {
    await callHost("dns.deleteRecord", { zone, record });
  },
  dnsQuery: async (name, type, result) => {
    await callHost("dns.query", { name, type, result });
  },
  certsStore: async (name, certPem, keyPem, meta) => {
    await callHost("certs.store", { name, certPem, keyPem, meta });
  },
  resolveTxt: async (name) => {
    try {
      const records = await dnsResolveTxt(name);
      return records.map((chunks) => chunks.join(""));
    } catch {
      return []; // NXDOMAIN / not yet propagated -- treated as "not visible yet", not an error
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

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
      if (msg.method !== "cert.ensure") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such task: ${msg.method}` } })}\n`);
        return;
      }
      const result = await certEnsure(deps, msg.params as CertEnsureInput);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } })}\n`);
    }
  })();
});
