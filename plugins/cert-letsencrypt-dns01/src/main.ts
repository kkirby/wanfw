import { createInterface } from "node:readline";
import { request as httpsRequest } from "node:https";
import { Resolver, lookup as dnsLookup } from "node:dns/promises";
import { certEnsure, type CertEnsureDeps, type CertEnsureInput, type DnsRecord } from "./cert-ensure.js";
import type { AcmeHttpFn } from "./acme-client.js";

/**
 * `WANFW_DNS01_RESOLVER` (host[:port], T4.7): against real DNS providers
 * this plugin's propagation polling and the ACME server's own DNS-01
 * validation both hit the same real, public authoritative chain, so the
 * default system resolver is correct. Against Pebble, the two diverge --
 * Pebble validates by querying pebble-challtestsrv's own fake DNS server
 * directly (`-dnsserver` flag), not real DNS, so this plugin's own
 * propagation check needs pointing at the exact same fake server or it
 * would poll a real DNS chain that will NXDOMAIN forever and time out,
 * even though the actual ACME validation Pebble performs would succeed.
 */
let resolverReady: Promise<Resolver> | undefined;
function getResolver(): Promise<Resolver> {
  if (!resolverReady) {
    resolverReady = (async () => {
      const resolver = new Resolver();
      const override = process.env.WANFW_DNS01_RESOLVER;
      if (override) {
        const [host, port] = override.split(":");
        // node:dns's setServers requires an IP, not a hostname -- resolve
        // the (Docker-service-name) host once via the default resolver
        // first, then pin this dedicated resolver to that address.
        const { address } = await dnsLookup(host!);
        resolver.setServers([port ? `${address}:${port}` : address]);
      }
      return resolver;
    })();
  }
  return resolverReady;
}

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

/**
 * Real progress visibility through the ACME/DNS-01 flow -- found genuinely
 * missing during a live debugging session, where the only signal an
 * operator ever got was the final error (or nothing at all on success).
 * `log.emit` already lands in the orchestrator's own structured log
 * (`docker logs wanfw-orchestrator`), so this is visible in real time, not
 * just after the fact. Best-effort: logging itself must never be what
 * breaks a cert issuance.
 */
async function logStep(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): Promise<void> {
  try {
    await callHost("log.emit", { level, msg, fields });
  } catch {
    // never let logging itself fail the actual task
  }
}

// RFC 8555 doesn't mandate a User-Agent, and production Let's Encrypt
// tolerates its absence (T4.4's live verification against it never
// surfaced this) -- but Pebble (T4.7) enforces the ACME best-practice
// requirement strictly and 400s every request without one. Sent
// unconditionally since a well-behaved client should send it regardless
// of which server happens to be lenient.
const USER_AGENT = "wanfw-cert-letsencrypt-dns01/0.1.0";

const httpFn: AcmeHttpFn = (method, url, body) => {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method,
        headers: {
          "user-agent": USER_AGENT,
          ...(body ? { "content-type": "application/jose+json", "content-length": Buffer.byteLength(body) } : {}),
        },
      },
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
    await logStep("info", "setting DNS-01 challenge record", { zone, recordType: record.type, recordName: record.name });
    await callHost("dns.setRecord", { zone, record });
  },
  dnsDeleteRecord: async (zone, record: DnsRecord) => {
    await callHost("dns.deleteRecord", { zone, record });
    await logStep("info", "cleaned up DNS-01 challenge record", { zone, recordType: record.type, recordName: record.name });
  },
  dnsQuery: async (name, type, result) => {
    await callHost("dns.query", { name, type, result });
  },
  certsStore: async (name, certPem, keyPem, meta) => {
    await callHost("certs.store", { name, certPem, keyPem, meta });
    await logStep("info", "certificate stored", { name });
  },
  resolveTxt: async (name) => {
    try {
      const resolver = await getResolver();
      const records = await resolver.resolveTxt(name);
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
      const input = msg.params as CertEnsureInput;
      await logStep("info", "cert.ensure starting", { certName: input.certName, zone: input.zone, names: input.names });
      try {
        const result = await certEnsure(deps, input);
        await logStep("info", "cert.ensure succeeded", { certName: input.certName });
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      } catch (err) {
        await logStep("error", "cert.ensure failed", { certName: input.certName, zone: input.zone, error: (err as Error).message });
        throw err;
      }
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } })}\n`);
    }
  })();
});
