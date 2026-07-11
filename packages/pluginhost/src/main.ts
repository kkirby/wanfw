/**
 * Placeholder entrypoint (T0.3). Real supervisor (dial orch-plugin.sock,
 * NDJSON JSON-RPC, child spawn) lands in T2.6. This just proves the image
 * boots, stays up, and logs structured JSON to stdout.
 */
function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), component: "pluginhost", ...fields })}\n`);
}

log({ level: "info", msg: "pluginhost placeholder starting" });

const interval = setInterval(() => {
  log({ level: "info", msg: "idle" });
}, 10_000);

function shutdown(signal: string): void {
  log({ level: "info", msg: "shutting down", signal });
  clearInterval(interval);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
