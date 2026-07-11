import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { runPlugin } from "./run-plugin.js";

function readOneMessage(stream: PassThrough): Promise<unknown> {
  return new Promise((resolve) => {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) resolve(JSON.parse(buf.slice(0, idx)));
    });
  });
}

describe("runPlugin", () => {
  it("dispatches an incoming task request to the matching handler and writes the result", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    runPlugin({
      tasks: {
        echo: async (input) => input,
      },
      stdin,
      stdout,
    });

    const outPromise = readOneMessage(stdout);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "1", method: "echo", params: { hello: "world" } })}\n`);
    const out = (await outPromise) as { id: string; result: unknown };
    expect(out.id).toBe("1");
    expect(out.result).toEqual({ hello: "world" });
  });

  it("gives the task handler a HostApiClient that forwards calls upstream", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    runPlugin({
      tasks: {
        useHost: async (_input, host) => {
          // Fire-and-forget from the handler's perspective; we just assert
          // the forwarded host.call frame appears on stdout.
          void host.logEmit("info", "hello from plugin");
          return { started: true };
        },
      },
      stdin,
      stdout,
    });

    const frames: unknown[] = [];
    let buf = "";
    stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        frames.push(JSON.parse(buf.slice(0, idx)));
        buf = buf.slice(idx + 1);
      }
    });

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "1", method: "useHost", params: {} })}\n`);
    await new Promise((r) => setTimeout(r, 20));

    const hostCallFrame = frames.find((f) => (f as { method?: string }).method === "host.call");
    expect(hostCallFrame).toBeDefined();
    expect((hostCallFrame as { params: { method: string } }).params.method).toBe("log.emit");
  });
});
