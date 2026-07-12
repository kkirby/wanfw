import { createInterface } from "node:readline";
import { createConnection } from "node:net";
import { applyDnsRecord, type DnsApplyInput, type PostJsonFn } from "./apply.js";

/**
 * Hand-rolled NDJSON JSON-RPC loop -- same self-contained-bundle shape as
 * every other v1 plugin's entrypoint. No host.call round trips at all:
 * unlike a real dns-provider plugin, there are no credentials to read from
 * secrets (challtestsrv is unauthenticated test infra), so this is the
 * simplest entrypoint in the whole plugin set.
 */
const challSrvUrl = process.env.WANFW_CHALLTESTSRV_URL ?? "http://pebble-challtestsrv:8055";

/**
 * Hand-rolled minimal HTTP/1.1 client over a raw `node:net` socket --
 * deliberately not `node:http.request` (T4.7's own genuinely new
 * discovery, distinct from and more surprising than T4.2's fetch()/WASM
 * finding): under this sandbox's `prlimit --as` ceiling, plain
 * `node:http.request` from an ESM entrypoint reliably crashes with the
 * exact same `WebAssembly.instantiate(): Out of memory` error T4.2
 * documented for `fetch()` -- reproduced live against this plugin's real
 * bundle, isolated down to "http (not https) + ESM (not CJS)" by direct
 * experimentation, and confirmed unrelated to the memMb ceiling itself
 * (raising it to 2048MB made no difference, same as T4.2's fetch()
 * finding: the WASM engine's virtual-address reservation is a fixed cost,
 * not something a larger ceiling absorbs). `node:https.request` does NOT
 * hit this path in ESM mode (also confirmed live) -- but challtestsrv's
 * management API is plain HTTP with no TLS option, so switching protocols
 * isn't available here. A raw `node:net` socket never touches Node's HTTP
 * client module at all, sidestepping whatever internal code path triggers
 * this, and challtestsrv's request/response shape is simple enough
 * (small JSON body, `Connection: close`) that a hand-rolled request/status
 * line is far less code than working around the underlying Node bug.
 */
const postJson: PostJsonFn = (url, body) => {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const request = [
      `POST ${target.pathname} HTTP/1.1`,
      `Host: ${target.host}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(payload)}`,
      "Connection: close",
      "",
      payload,
    ].join("\r\n");

    const socket = createConnection({ host: target.hostname, port: Number(target.port) }, () => socket.write(request));
    let raw = "";
    socket.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("end", () => {
      const statusLine = raw.split("\r\n", 1)[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      if (status >= 200 && status < 300) resolve();
      else reject(new Error(`challtestsrv ${url} returned ${statusLine}: ${raw}`));
    });
  });
};

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  void (async () => {
    let id: unknown;
    try {
      const msg = JSON.parse(line) as { id: unknown; method?: string; params?: unknown };
      id = msg.id;
      if (msg.method !== "dns.apply") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such task: ${msg.method}` } })}\n`);
        return;
      }
      const result = await applyDnsRecord(postJson, challSrvUrl, msg.params as DnsApplyInput);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } })}\n`);
    }
  })();
});
