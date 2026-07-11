import { Command } from "commander";
import { adminRequest, AdminSocketUnreachableError } from "./admin-client.js";
import { EXIT_CODES } from "./exit-codes.js";

export interface CliDeps {
  adminSocketPath: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Builds the commander program. Exported separately from execution so tests can drive it without process.exit. */
export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program.name("wanfwctl-inner").description("wanfw control CLI (inner, speaks to admin.sock)");
  program.exitOverride(); // let callers catch instead of the default process.exit

  program
    .command("status")
    .description("Show orchestrator heartbeat state")
    .action(async () => {
      try {
        const res = await adminRequest(deps.adminSocketPath, "GET", "/status");
        if (res.status !== 200) {
          deps.stderr(`error: admin socket returned ${res.status}`);
          process.exitCode = EXIT_CODES.internalError;
          return;
        }
        deps.stdout(JSON.stringify(res.body, null, 2));
        process.exitCode = EXIT_CODES.ok;
      } catch (err) {
        if (err instanceof AdminSocketUnreachableError) {
          deps.stderr(`error: orchestrator admin socket unreachable: ${err.message}`);
          process.exitCode = EXIT_CODES.daemonUnreachable;
          return;
        }
        deps.stderr(`error: ${(err as Error).message}`);
        process.exitCode = EXIT_CODES.internalError;
      }
    });

  return program;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const program = buildProgram(deps);
  process.exitCode = EXIT_CODES.ok;
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    // commander throws on --help/unknown command when exitOverride() is set
    const code = (err as { exitCode?: number }).exitCode;
    return code === 0 ? EXIT_CODES.ok : EXIT_CODES.usage;
  }
  return process.exitCode as number;
}
