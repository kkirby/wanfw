type LogFields = Record<string, unknown>;

/** Structured JSON logging to stdout, same shape as the orchestrator's `logger.ts` (spec §13: no log stack shipped, `docker logs` is the pipeline). */
export function createLogger(component: string) {
  function emit(level: "info" | "warn" | "error", msg: string, fields?: LogFields): void {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), component, level, msg, ...fields })}\n`);
  }
  return {
    info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
    warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
    error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;

export const log = createLogger("tier1");
