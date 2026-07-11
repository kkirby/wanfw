import type { JsonRpcConnection } from "@wanfw/pluginhost";

/**
 * Typed host API client (§6.6/§6.7) over the child's own JSON-RPC
 * connection. Every call is forwarded upstream as a `host.call` request;
 * the pluginhost tags it with `invocationId` and the orchestrator is the
 * sole authority on whether it's allowed (grants live server-side, never
 * trusted from the plugin -- invariant #8).
 */
export class HostApiClient {
  constructor(private connection: JsonRpcConnection) {}

  private call(method: string, args?: unknown): Promise<unknown> {
    return this.connection.call("host.call", { method, args });
  }

  async stateGet(key: string): Promise<string | null> {
    const res = (await this.call("state.get", { key })) as { value: string | null };
    return res.value;
  }

  async statePut(key: string, value: string): Promise<void> {
    await this.call("state.put", { key, value });
  }

  async stateDelete(key: string): Promise<void> {
    await this.call("state.delete", { key });
  }

  async logEmit(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): Promise<void> {
    await this.call("log.emit", { level, msg, fields });
  }
}
