import { Command } from "commander";
import { adminRequest, AdminSocketUnreachableError } from "./admin-client.js";
import { EXIT_CODES } from "./exit-codes.js";

export interface CliDeps {
  adminSocketPath: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readStdin?: () => Promise<string>;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Wraps an admin-socket call with the shared error -> exit-code mapping. */
async function withAdminRequest(
  deps: CliDeps,
  method: string,
  path: string,
  body: unknown,
  onOk: (responseBody: unknown) => void,
): Promise<void> {
  try {
    const res = await adminRequest(deps.adminSocketPath, method, path, body);
    if (res.status < 200 || res.status >= 300) {
      deps.stderr(`error: admin socket returned ${res.status}: ${JSON.stringify(res.body)}`);
      process.exitCode = EXIT_CODES.internalError;
      return;
    }
    onOk(res.body);
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
      await withAdminRequest(deps, "GET", "/status", undefined, (body) => {
        deps.stdout(JSON.stringify(body, null, 2));
      });
    });

  const key = program.command("key").description("Signing key operations (ADR-5)");

  key
    .command("show")
    .description("Print the current signing public key (PEM)")
    .action(async () => {
      await withAdminRequest(deps, "GET", "/key", undefined, (body) => {
        deps.stdout((body as { publicKeyPem: string }).publicKeyPem.trim());
      });
    });

  key
    .command("rotate")
    .description("Generate a new signing key and re-sign all live trust/grant/approval records")
    .action(async () => {
      await withAdminRequest(deps, "POST", "/key/rotate", undefined, (body) => {
        deps.stdout(`rotated. new public key:\n${(body as { publicKeyPem: string }).publicKeyPem.trim()}`);
      });
    });

  key
    .command("import")
    .description("Replace signing key custody with a PKCS8 PEM read from stdin")
    .action(async () => {
      const privateKeyPem = await (deps.readStdin ?? readAllStdin)();
      if (!privateKeyPem.trim()) {
        deps.stderr("error: no key material on stdin");
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      await withAdminRequest(deps, "POST", "/key/import", { privateKeyPem }, (body) => {
        deps.stdout(`imported. new public key:\n${(body as { publicKeyPem: string }).publicKeyPem.trim()}`);
      });
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
