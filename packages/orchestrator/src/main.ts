/**
 * Placeholder entrypoint (T0.3). Real orchestrator process (heartbeat file,
 * status/admin UDS servers) lands in T1.1. This just proves the image boots,
 * stays up, and logs structured JSON to stdout per §13.
 */
function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), component: "orchestrator", ...fields })}\n`);
}

log({ level: "info", msg: "orchestrator placeholder starting" });

const interval = setInterval(() => {
  log({ level: "info", msg: "heartbeat" });
}, 10_000);

function shutdown(signal: string): void {
  log({ level: "info", msg: "shutting down", signal });
  clearInterval(interval);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
