import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { NdjsonReader, writeNdjson } from "./ndjson.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

export type MethodHandler = (params: unknown) => Promise<unknown>;

/**
 * Bidirectional JSON-RPC 2.0 connection over NDJSON framing (spec §6.5).
 * Either side may originate requests -- this is legal JSON-RPC 2.0
 * bidirectional usage and is how the orchestrator pushes `invoke` jobs to
 * the pluginhost over one persistent connection (plan interpretation 1).
 */
export class JsonRpcConnection {
  private writable: Writable;
  private reader: NdjsonReader;
  private methods = new Map<string, MethodHandler>();
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(readable: Readable, writable: Writable) {
    this.writable = writable;
    this.reader = new NdjsonReader(readable);
    this.reader.on("message", (msg: JsonRpcMessage) => this.handleMessage(msg));
    this.reader.on("end", () => this.handleClose());
    // Same rationale as the writable listener above: an unlistened "error"
    // event on an EventEmitter throws. A dead child's stdout closing/erroring
    // just means the connection is done.
    this.reader.on("error", () => this.handleClose());
    // Writing to a child's stdin after it has died (OOM-killed, crashed,
    // or SIGKILLed on timeout) surfaces as an async EPIPE on the writable
    // side. Without this listener Node treats it as an uncaught exception
    // and crashes the whole process; the call already fails cleanly via
    // handleClose()/timeout, so this is just a safety net, not new behavior.
    this.writable.on("error", () => this.handleClose());
  }

  registerMethod(name: string, handler: MethodHandler): void {
    this.methods.set(name, handler);
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new Error("connection closed");
    const id = randomUUID();
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    writeNdjson(this.writable, request);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    writeNdjson(this.writable, notification);
  }

  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if ("method" in msg && "id" in msg) {
      // incoming request
      const handler = this.methods.get(msg.method);
      if (!handler) {
        const error: JsonRpcError = {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        };
        writeNdjson(this.writable, error);
        return;
      }
      try {
        const result = await handler(msg.params);
        const success: JsonRpcSuccess = { jsonrpc: "2.0", id: msg.id, result };
        writeNdjson(this.writable, success);
      } catch (err) {
        const error: JsonRpcError = {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: (err as Error).message },
        };
        writeNdjson(this.writable, error);
      }
      return;
    }

    if ("method" in msg) {
      // notification (no response expected)
      const handler = this.methods.get(msg.method);
      if (handler) void handler(msg.params);
      return;
    }

    // response to an outstanding call
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if ("error" in msg) {
      entry.reject(new Error(msg.error.message));
    } else {
      entry.resolve(msg.result);
    }
  }

  private handleClose(): void {
    this.closed = true;
    for (const [, entry] of this.pending) {
      entry.reject(new Error("connection closed"));
    }
    this.pending.clear();
  }

  close(): void {
    this.handleClose();
  }
}
