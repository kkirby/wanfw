import { request } from "node:http";

export class AdminSocketUnreachableError extends Error {}

export interface AdminRequestResult {
  status: number;
  body: unknown;
}

/** Thin JSON-over-HTTP client for the admin Unix socket (§2.3). */
export function adminRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<AdminRequestResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
        timeout: 5_000,
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
    req.on("timeout", () => req.destroy(new AdminSocketUnreachableError("admin socket request timed out")));
    req.on("error", (err) => reject(new AdminSocketUnreachableError(err.message)));
    if (payload) req.write(payload);
    req.end();
  });
}
