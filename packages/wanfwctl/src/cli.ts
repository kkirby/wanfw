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
    process.exitCode = EXIT_CODES.ok;
    onOk(res.body); // may override process.exitCode (e.g. audit tail --verify on tamper detection)
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

  const audit = program.command("audit").description("Audit log operations (§12.3)");

  audit
    .command("tail")
    .description("Print audit log entries")
    .option("--verify", "recompute the hash chain and check checkpoint signatures")
    .action(async (opts: { verify?: boolean }) => {
      if (opts.verify) {
        await withAdminRequest(deps, "POST", "/audit/verify", undefined, (body) => {
          const result = body as { valid: boolean; entryCount: number; failedAtSeq?: number; reason?: string };
          if (result.valid) {
            deps.stdout(`ok: ${result.entryCount} entries, chain verified`);
          } else {
            deps.stderr(`TAMPER DETECTED at seq ${result.failedAtSeq}: ${result.reason}`);
            process.exitCode = EXIT_CODES.refused;
          }
        });
        return;
      }
      await withAdminRequest(deps, "GET", "/audit", undefined, (body) => {
        const { entries } = body as { entries: unknown[] };
        for (const entry of entries) {
          deps.stdout(JSON.stringify(entry));
        }
      });
    });

  const plugin = program.command("plugin").description("Plugin trust flow (ADR-5)");

  plugin
    .command("list")
    .description("List trusted plugins, or pending staged bundles")
    .option("--pending", "list staged bundles awaiting trust instead of already-trusted plugins")
    .action(async (opts: { pending?: boolean }) => {
      const path = opts.pending ? "/plugins?pending=true" : "/plugins";
      await withAdminRequest(deps, "GET", path, undefined, (body) => {
        deps.stdout(JSON.stringify(body, null, 2));
      });
    });

  plugin
    .command("show <id>")
    .description("Show a trusted plugin's manifest and granted capabilities")
    .action(async (id: string) => {
      await withAdminRequest(deps, "GET", `/plugins/${encodeURIComponent(id)}`, undefined, (body) => {
        deps.stdout(JSON.stringify(body, null, 2));
      });
    });

  plugin
    .command("trust [idAtHash]")
    .description("Trust a staged bundle (id@sha256), or all built-ins with --builtin-all")
    .option("--builtin-all", "batch-trust every built-in the pluginhost ships")
    .option("--yes", "skip the confirmation prompt (required for non-interactive use)")
    .action(async (idAtHash: string | undefined, opts: { builtinAll?: boolean; yes?: boolean }) => {
      if (opts.builtinAll) {
        if (!opts.yes) {
          deps.stdout("Re-run with --yes to confirm batch-trusting every built-in plugin.");
          process.exitCode = EXIT_CODES.ok;
          return;
        }
        await withAdminRequest(deps, "POST", "/plugins/trust-builtins", undefined, (body) => {
          deps.stdout(JSON.stringify(body, null, 2));
        });
        return;
      }

      if (!idAtHash || !idAtHash.includes("@")) {
        deps.stderr("usage: wanfwctl plugin trust <id>@<sha256> [--yes]");
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      const [id, sha256] = idAtHash.split("@", 2) as [string, string];
      if (!opts.yes) {
        deps.stdout(`Re-run with --yes to confirm trusting ${id}@${sha256} after reviewing its capability requests.`);
        process.exitCode = EXIT_CODES.ok;
        return;
      }
      await withAdminRequest(deps, "POST", "/plugins/trust", { id, sha256 }, (body) => {
        const result = body as { grantedCaps: string[]; upgradeDiff?: { added: unknown[]; removed: unknown[] } };
        deps.stdout(`trusted ${id}@${sha256}. capabilities: ${result.grantedCaps.join(", ")}`);
        if (result.upgradeDiff && (result.upgradeDiff.added.length || result.upgradeDiff.removed.length)) {
          deps.stdout(`upgrade diff: +${result.upgradeDiff.added.length} -${result.upgradeDiff.removed.length} capabilities`);
        }
      });
    });

  plugin
    .command("untrust <id>")
    .description("Revoke trust in a plugin; subsequent plans referencing it fail validation")
    .option("--yes", "skip the confirmation prompt (required for non-interactive use)")
    .action(async (id: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        deps.stdout(`Re-run with --yes to confirm untrusting ${id}.`);
        process.exitCode = EXIT_CODES.ok;
        return;
      }
      await withAdminRequest(deps, "POST", "/plugins/untrust", { id }, (body) => {
        deps.stdout(JSON.stringify(body, null, 2));
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
