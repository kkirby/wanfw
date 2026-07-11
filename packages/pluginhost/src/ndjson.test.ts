import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { NdjsonReader, writeNdjson } from "./ndjson.js";

describe("NdjsonReader / writeNdjson", () => {
  it("parses a single complete line into a message event", async () => {
    const stream = new PassThrough();
    const reader = new NdjsonReader(stream);
    const messages: unknown[] = [];
    reader.on("message", (m) => messages.push(m));

    stream.write('{"a":1}\n');
    await new Promise((r) => setImmediate(r));
    expect(messages).toEqual([{ a: 1 }]);
  });

  it("buffers a partial line across chunks", async () => {
    const stream = new PassThrough();
    const reader = new NdjsonReader(stream);
    const messages: unknown[] = [];
    reader.on("message", (m) => messages.push(m));

    stream.write('{"a":');
    await new Promise((r) => setImmediate(r));
    expect(messages).toEqual([]);
    stream.write("1}\n");
    await new Promise((r) => setImmediate(r));
    expect(messages).toEqual([{ a: 1 }]);
  });

  it("parses multiple messages delivered in one chunk", async () => {
    const stream = new PassThrough();
    const reader = new NdjsonReader(stream);
    const messages: unknown[] = [];
    reader.on("message", (m) => messages.push(m));

    stream.write('{"a":1}\n{"a":2}\n');
    await new Promise((r) => setImmediate(r));
    expect(messages).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("emits an error for a malformed line instead of throwing", async () => {
    const stream = new PassThrough();
    const reader = new NdjsonReader(stream);
    const errors: Error[] = [];
    reader.on("error", (e) => errors.push(e));

    stream.write("not json\n");
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveLength(1);
  });

  it("writeNdjson appends exactly one trailing newline", () => {
    const stream = new PassThrough();
    let written = "";
    stream.on("data", (c) => (written += c.toString()));
    writeNdjson(stream, { a: 1 });
    expect(written).toBe('{"a":1}\n');
  });
});
