import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { existsSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export interface RouteContext {
  req: IncomingMessage;
  params: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (ctx: RouteContext) => Promise<{ status: number; body: unknown }>;

export interface RouteEntry {
  method: string;
  path: string;
  handler: RouteHandler;
}

/**
 * Tiny hand-rolled JSON-in/JSON-out route dispatcher over HTTP.
 * No framework, per plan §1: "node:http servers bound to Unix socket paths".
 */
export class JsonUdsRouter {
  private routes: RouteEntry[] = [];

  register(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), path, handler });
  }

  /** Exposed for the T1.2 allowlist test: enumerate the registered route table. */
  listRoutes(): Array<{ method: string; path: string }> {
    return this.routes.map(({ method, path }) => ({ method, path }));
  }

  private match(method: string, pathname: string): { entry: RouteEntry; params: Record<string, string> } | undefined {
    for (const entry of this.routes) {
      if (entry.method !== method) continue;
      const params = matchPath(entry.path, pathname);
      if (params) return { entry, params };
    }
    return undefined;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://unix");
    const method = req.method ?? "GET";
    const match = this.match(method, url.pathname);

    if (!match) {
      writeJson(res, 404, { error: "not_found", method, path: url.pathname });
      return;
    }

    let body: unknown = undefined;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      writeJson(res, 400, { error: "invalid_json", message: (err as Error).message });
      return;
    }

    try {
      const result = await match.entry.handler({ req, params: match.params, body });
      writeJson(res, result.status, result.body);
    } catch (err) {
      writeJson(res, 500, { error: "internal_error", message: (err as Error).message });
    }
  }
}

function matchPath(pattern: string, actual: string): Record<string, string> | undefined {
  const patternParts = pattern.split("/").filter(Boolean);
  const actualParts = actual.split("/").filter(Boolean);
  if (patternParts.length !== actualParts.length) return undefined;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]!;
    const a = actualParts[i]!;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return undefined;
    }
  }
  return params;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;
  return JSON.parse(raw);
}

/** Unlinks a stale socket file (if present) before listening; creates the parent dir. */
export function listenOnUnixSocket(router: JsonUdsRouter, socketPath: string, mode = 0o660): Server {
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }
  const server = createServer((req, res) => {
    void router.handle(req, res);
  });
  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, mode);
    } catch {
      // best-effort; some CI/dev filesystems restrict chmod on sockets
    }
  });
  return server;
}
