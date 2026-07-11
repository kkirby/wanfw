import "server-only";
import { request } from "node:http";

// Never import this module from client components: it is server-side only
// (server components, server actions, route handlers), and it never touches
// the plugin socket (invariant #3 -- tier1 has no path to orch-plugin.sock).
const STATUS_SOCKET_PATH = process.env.WANFW_STATUS_SOCKET_PATH ?? "/run/wanfw/orch-status.sock";

export interface OrchRequestResult {
  status: number;
  body: unknown;
}

export function orchRequest(method: string, path: string, body?: unknown): Promise<OrchRequestResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath: STATUS_SOCKET_PATH,
        path,
        method,
        timeout: 5_000,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("orch-status.sock request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function getFrameworkStatus(): Promise<OrchRequestResult> {
  return orchRequest("GET", "/status");
}
