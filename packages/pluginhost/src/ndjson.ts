import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

/**
 * Newline-delimited JSON framing over a duplex byte stream (spec §6.5's
 * "our choice" framing for JSON-RPC 2.0). Emits one "message" event per
 * complete line; partial lines are buffered across chunks.
 */
export class NdjsonReader extends EventEmitter {
  private buffer = "";

  constructor(readable: Readable) {
    super();
    readable.setEncoding("utf8");
    readable.on("data", (chunk: string) => this.onData(chunk));
    readable.on("end", () => this.emit("end"));
    readable.on("error", (err: Error) => this.emit("error", err));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === "") continue;
      try {
        this.emit("message", JSON.parse(line));
      } catch (err) {
        this.emit("error", new Error(`invalid NDJSON line: ${(err as Error).message}`));
      }
    }
  }
}

export function writeNdjson(writable: Writable, message: unknown): void {
  writable.write(`${JSON.stringify(message)}\n`);
}
