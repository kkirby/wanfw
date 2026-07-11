import { describe, expect, it } from "vitest";
import { invokePluginForTest, FakeCapabilityError } from "./test-harness.js";
import type { HostApiClient } from "./host-client.js";

describe("invokePluginForTest", () => {
  it("runs a task handler and returns its result", async () => {
    const { result, error } = await invokePluginForTest({
      task: async (input: { n: number }) => ({ doubled: input.n * 2 }),
      input: { n: 21 },
    });
    expect(error).toBeUndefined();
    expect(result).toEqual({ doubled: 42 });
  });

  it("records every host API call the handler makes", async () => {
    const { hostCalls } = await invokePluginForTest({
      task: async (_input, host: HostApiClient) => {
        await host.statePut("k", "v");
        await host.stateGet("k");
        return {};
      },
      input: {},
    });
    expect(hostCalls.map((c) => c.method)).toEqual(["statePut", "stateGet"]);
  });

  it("state seeded via initialState is visible to stateGet", async () => {
    const { result } = await invokePluginForTest({
      task: async (_input, host: HostApiClient) => ({ value: await host.stateGet("existing") }),
      input: {},
      initialState: { existing: "seed-value" },
    });
    expect(result).toEqual({ value: "seed-value" });
  });

  it("simulates a capability failure via denyMethods, and the task's own error handling is exercised", async () => {
    const { result, error } = await invokePluginForTest({
      task: async (_input, host: HostApiClient) => {
        try {
          await host.stateGet("secret-key");
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: (err as Error).message };
        }
      },
      input: {},
      denyMethods: ["stateGet"],
    });
    expect(error).toBeUndefined();
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("capability denied") });
  });

  it("an uncaught capability failure surfaces as the harness's error result", async () => {
    const { error, result } = await invokePluginForTest({
      task: async (_input, host: HostApiClient) => {
        await host.statePut("k", "v"); // not caught by the task
        return { ok: true };
      },
      input: {},
      denyMethods: ["statePut"],
    });
    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(FakeCapabilityError);
  });
});
