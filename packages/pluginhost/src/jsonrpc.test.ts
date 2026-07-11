import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { JsonRpcConnection } from "./jsonrpc.js";

function makePair(): [JsonRpcConnection, JsonRpcConnection] {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new JsonRpcConnection(bToA, aToB);
  const b = new JsonRpcConnection(aToB, bToA);
  return [a, b];
}

describe("JsonRpcConnection", () => {
  it("call/response round-trips a result", async () => {
    const [a, b] = makePair();
    b.registerMethod("echo", async (params) => params);
    const result = await a.call("echo", { hello: "world" });
    expect(result).toEqual({ hello: "world" });
  });

  it("propagates handler errors as rejected calls", async () => {
    const [a, b] = makePair();
    b.registerMethod("boom", async () => {
      throw new Error("kaboom");
    });
    await expect(a.call("boom")).rejects.toThrow("kaboom");
  });

  it("rejects a call for an unregistered method with method-not-found", async () => {
    const [a] = makePair();
    await expect(a.call("nope")).rejects.toThrow(/method not found/);
  });

  it("supports server-to-client (bidirectional) requests over one connection", async () => {
    // The side that "called" first can still receive a request FROM the
    // other side on the same connection -- this is the mechanism the
    // orchestrator uses to push `invoke` jobs to the pluginhost.
    const [a, b] = makePair();
    a.registerMethod("push", async (params) => ({ received: params }));
    const result = await b.call("push", { job: 1 });
    expect(result).toEqual({ received: { job: 1 } });
  });

  it("notify does not expect nor produce a response", async () => {
    const [a, b] = makePair();
    let seen: unknown;
    b.registerMethod("log", async (params) => {
      seen = params;
    });
    a.notify("log", { msg: "hi" });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual({ msg: "hi" });
  });

  it("concurrent calls on the same connection resolve independently (no cross-talk)", async () => {
    const [a, b] = makePair();
    b.registerMethod("double", async (params) => (params as { n: number }).n * 2);
    const results = await Promise.all([a.call("double", { n: 1 }), a.call("double", { n: 2 }), a.call("double", { n: 3 })]);
    expect(results).toEqual([2, 4, 6]);
  });
});
