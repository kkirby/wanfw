import type { HostApiClient } from "./host-client.js";
import type { TaskHandler } from "./task-types.js";

export class FakeCapabilityError extends Error {}

export interface HostCallRecord {
  method: string;
  args: unknown[];
}

export interface InvokePluginForTestOptions<TInput> {
  task: TaskHandler<TInput, unknown>;
  input: TInput;
  /** Method names (e.g. "stateGet", "logEmit") to simulate as capability-denied. */
  denyMethods?: string[];
  /** Seed state for stateGet, keyed exactly like the real plugin_kv namespace. */
  initialState?: Record<string, string>;
}

export interface InvokePluginForTestResult<TOutput> {
  result?: TOutput;
  error?: Error;
  hostCalls: HostCallRecord[];
  finalState: Record<string, string>;
}

/**
 * Test harness for plugin authors (§6.7): fakes the host API entirely
 * in-process (no pluginhost, no orchestrator, no real sockets) so a
 * plugin repo can unit-test both its happy path and its handling of a
 * denied capability, by naming the host method to deny.
 */
export async function invokePluginForTest<TInput, TOutput>(
  options: InvokePluginForTestOptions<TInput>,
): Promise<InvokePluginForTestResult<TOutput>> {
  const hostCalls: HostCallRecord[] = [];
  const state: Record<string, string> = { ...(options.initialState ?? {}) };
  const denied = new Set(options.denyMethods ?? []);

  function record(method: string, args: unknown[]): void {
    hostCalls.push({ method, args });
  }

  function guard(method: string): void {
    if (denied.has(method)) {
      throw new FakeCapabilityError(`capability denied (simulated): ${method}`);
    }
  }

  const fakeHost = {
    stateGet: async (key: string) => {
      record("stateGet", [key]);
      guard("stateGet");
      return state[key] ?? null;
    },
    statePut: async (key: string, value: string) => {
      record("statePut", [key, value]);
      guard("statePut");
      state[key] = value;
    },
    stateDelete: async (key: string) => {
      record("stateDelete", [key]);
      guard("stateDelete");
      delete state[key];
    },
    logEmit: async (level: string, msg: string, fields?: Record<string, unknown>) => {
      record("logEmit", [level, msg, fields]);
      guard("logEmit");
    },
  } as unknown as HostApiClient;

  try {
    const result = (await options.task(options.input, fakeHost)) as TOutput;
    return { result, hostCalls, finalState: state };
  } catch (err) {
    return { error: err as Error, hostCalls, finalState: state };
  }
}
