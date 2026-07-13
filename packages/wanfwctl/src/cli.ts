import { Command } from "commander";
import { adminRequest, AdminSocketUnreachableError } from "./admin-client.js";
import { EXIT_CODES } from "./exit-codes.js";
import { runInit } from "./init.js";

export interface CliDeps {
  adminSocketPath: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readStdin?: () => Promise<string>;
  /** Prompts the operator interactively; defaults to a real readline over stdin/stdout (no TTY over `docker exec -i`, so answers are never masked). Injectable for tests. */
  prompt?: (question: string) => Promise<string>;
}

// Feeds prompt() calls from stdin incrementally, not by reading to EOF
// first. `docker exec -i` (the only way `wanfwctl` ever runs) never
// provides a real TTY, and Node's readline has a well-documented gotcha
// over piped input: 'line' events fire as soon as data arrives regardless
// of whether a `.question()` call is actively awaiting one, so lines that
// arrive before the next `.question()` call can be delivered to the wrong
// call or dropped entirely. A single persistent 'data' listener that
// splits on newlines and either resolves a pending question or queues the
// line for the next one sidesteps that race without needing to buffer
// the *entire* input first: an operator piping a small answers file gets
// every line delivered in order the instant it's available, and an
// operator typing answers live at a real terminal (no piped file at all)
// gets each question printed immediately rather than the process
// appearing to hang until they send EOF (Ctrl-D) -- the bug this eager-
// read version had, since it printed nothing until the entire stream
// closed.
let stdinLineListenerAttached = false;
let stdinLineBuffer = "";
const queuedStdinLines: string[] = [];
const pendingStdinLineResolvers: Array<(line: string) => void> = [];

function ensureStdinLineListener(): void {
  if (stdinLineListenerAttached) return;
  stdinLineListenerAttached = true;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    stdinLineBuffer += chunk;
    let idx: number;
    while ((idx = stdinLineBuffer.indexOf("\n")) !== -1) {
      const line = stdinLineBuffer.slice(0, idx).replace(/\r$/, "");
      stdinLineBuffer = stdinLineBuffer.slice(idx + 1);
      const resolver = pendingStdinLineResolvers.shift();
      if (resolver) resolver(line);
      else queuedStdinLines.push(line);
    }
  });
}

function nextStdinLine(): Promise<string> {
  ensureStdinLineListener();
  const queued = queuedStdinLines.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise<string>((resolve) => pendingStdinLineResolvers.push(resolve));
}

async function defaultPrompt(question: string): Promise<string> {
  process.stdout.write(question);
  const line = await nextStdinLine();
  process.stdout.write(`${line}\n`); // no TTY to echo it for us
  return line;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** T6.1: prints any catastrophic-grant/self-exposure banners on a gated-plan body unmissably, before the rest of the output. */
function printBanners(deps: CliDeps, body: unknown): void {
  const banners = (body as { banners?: string[] } | undefined)?.banners ?? [];
  for (const banner of banners) {
    deps.stdout("!".repeat(banner.length > 72 ? 72 : banner.length));
    deps.stdout(banner);
    deps.stdout("!".repeat(banner.length > 72 ? 72 : banner.length));
  }
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

  plugin
    .command("invoke <id> <task> [inputJson]")
    .description("Manually invoke a trusted plugin's task (debugging aid; the reconciler does this automatically from T3.x)")
    .option("--wall-ms <n>", "wall-clock timeout in milliseconds", (v) => parseInt(v, 10), 30000)
    .action(async (id: string, task: string, inputJson: string | undefined, opts: { wallMs: number }) => {
      let input: unknown = {};
      if (inputJson) {
        try {
          input = JSON.parse(inputJson);
        } catch {
          deps.stderr("error: inputJson must be valid JSON");
          process.exitCode = EXIT_CODES.usage;
          return;
        }
      }
      await withAdminRequest(
        deps,
        "POST",
        `/plugins/${encodeURIComponent(id)}/invoke`,
        // memMb floor: V8 reserves a large CodeRange/heap arena at startup
        // regardless of actual usage, so any limit much below this kills
        // even a completely idle Node process under Linux prlimit --as
        // before it can do anything (discovered empirically in T2.6). The
        // safe floor is host/kernel-dependent -- 768MB was enough on the
        // dev machine T2.6 was built on, but GitHub Actions' ubuntu-latest
        // runner needs more (same SharedHeapDeserializer OOM, discovered via
        // "connection closed" invoke failures in `m1-plugin-runtime.sh`
        // under CI, T6.6-era); 1536MB matches the floor pluginhost's own
        // unit tests already raised to for the same reason.
        { task, input, limits: { wallMs: opts.wallMs, memMb: 1536, cpuSeconds: 30 } },
        (body) => {
          deps.stdout(JSON.stringify(body, null, 2));
        },
      );
    });

  const plan = program.command("plan").description("Powerful-plan approvals (ADR-4, ADR-6)");

  plan
    .command("list")
    .description("List gated plans (pending approval, or all)")
    .option("--pending", "list only plans awaiting approval")
    .action(async (opts: { pending?: boolean }) => {
      const path = opts.pending ? "/plans?pending=true" : "/plans";
      await withAdminRequest(deps, "GET", path, undefined, (body) => {
        deps.stdout(JSON.stringify(body, null, 2));
      });
    });

  plan
    .command("show <serviceId>")
    .description("Show a gated plan's human-rendered projection")
    .action(async (serviceId: string) => {
      await withAdminRequest(deps, "GET", `/plans/${encodeURIComponent(serviceId)}`, undefined, (body) => {
        printBanners(deps, body);
        deps.stdout(JSON.stringify(body, null, 2));
      });
    });

  plan
    .command("approve")
    .description("Approve a pending powerful plan, by service id or exact projection hash")
    .option("--service <id>", "approve by service id (the currently pending plan for that service)")
    .option("--hash <projectionHash>", "approve by exact projection hash")
    .action(async (opts: { service?: string; hash?: string }) => {
      if (!opts.service && !opts.hash) {
        deps.stderr("usage: wanfwctl plan approve (--service <id> | --hash <projectionHash>)");
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      if (opts.service) {
        // T6.1: print catastrophic-grant / self-exposure banners before the
        // approval takes effect, not just when browsing with `plan show`.
        const res = await adminRequest(deps.adminSocketPath, "GET", `/plans/${encodeURIComponent(opts.service)}`, undefined).catch(() => undefined);
        if (res && res.status >= 200 && res.status < 300) printBanners(deps, res.body);
      }
      await withAdminRequest(
        deps,
        "POST",
        "/plans/approve",
        { serviceId: opts.service, projectionHash: opts.hash },
        (body) => {
          deps.stdout(JSON.stringify(body, null, 2));
        },
      );
    });

  plan
    .command("revoke <projectionHash>")
    .description("Revoke an approval; the plan parks again on the next reconcile")
    .action(async (projectionHash: string) => {
      await withAdminRequest(deps, "POST", "/plans/revoke", { projectionHash }, (body) => {
        deps.stdout(JSON.stringify(body, null, 2));
      });
    });

  const secret = program.command("secret").description("Secrets store (§12.4) -- values only ever via stdin, never argv");

  secret
    .command("list")
    .description("List secret names and last-rotated timestamps (never values)")
    .action(async () => {
      await withAdminRequest(deps, "GET", "/secrets", undefined, (body) => {
        deps.stdout(JSON.stringify(body, null, 2));
      });
    });

  secret
    .command("set <name> [rejectedValueArg...]")
    .description("Set a secret's value, read from stdin (e.g. `echo -n VALUE | wanfwctl secret set <plugin>/<name>`)")
    .action(async (name: string, rejectedValueArg: string[]) => {
      // The value must never appear on argv (shell history, `ps`, process
      // listings all leak it) -- this catches `secret set <name> <value>`
      // and fails loudly rather than silently accepting/ignoring it.
      if (rejectedValueArg.length > 0) {
        deps.stderr("error: the secret value must be piped via stdin, not passed as an argument");
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      const value = await (deps.readStdin ?? readAllStdin)();
      if (!value.trim()) {
        deps.stderr("error: no value on stdin");
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      await withAdminRequest(deps, "POST", "/secrets", { name, value }, () => {
        deps.stdout(`set ${name}`);
      });
    });

  secret
    .command("unset <name>")
    .description("Remove a secret")
    .action(async (name: string) => {
      await withAdminRequest(deps, "POST", "/secrets/unset", { name }, () => {
        deps.stdout(`unset ${name}`);
      });
    });

  const cert = program.command("cert").description("Certificate store (§6.6, §9, T4.5) -- generations, rollback");

  cert
    .command("list")
    .description("List stored certs, their generations, and metadata")
    .action(async () => {
      await withAdminRequest(deps, "GET", "/certs", undefined, (body) => {
        deps.stdout(JSON.stringify(body, null, 2));
      });
    });

  cert
    .command("rollback <name>")
    .description("Roll back a cert to its previous generation")
    .action(async (name: string) => {
      await withAdminRequest(deps, "POST", `/certs/${encodeURIComponent(name)}/rollback`, undefined, (body) => {
        deps.stdout(JSON.stringify(body, null, 2));
      });
    });

  const framework = program
    .command("framework")
    .description("Framework document (T5.3) -- lives in wanfw_state, authored only here, never in wanfw_desired");

  framework
    .command("show")
    .description("Show the current framework document, or null if none has ever been set")
    .action(async () => {
      await withAdminRequest(deps, "GET", "/framework", undefined, (body) => {
        deps.stdout(JSON.stringify(body, null, 2));
      });
    });

  framework
    .command("set")
    .description("Set the framework document, read as JSON from stdin (e.g. `wanfwctl framework set < framework.json`)")
    .action(async () => {
      const raw = await (deps.readStdin ?? readAllStdin)();
      let doc: unknown;
      try {
        doc = JSON.parse(raw);
      } catch {
        deps.stderr("error: stdin is not valid JSON");
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      await withAdminRequest(deps, "POST", "/framework", doc, () => {
        deps.stdout("framework document set");
      });
    });

  const config = program.command("config").description("Framework-wide config knobs (T6.2)");

  config
    .command("set <key> <value>")
    .description("Set a config knob. Supported keys: strictApprovals=<powerful|all>")
    .action(async (key: string, value: string) => {
      if (key !== "strictApprovals") {
        deps.stderr(`error: unknown config key '${key}' (supported: strictApprovals)`);
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      if (value !== "powerful" && value !== "all") {
        deps.stderr("error: strictApprovals must be 'powerful' or 'all'");
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      const getRes = await adminRequest(deps.adminSocketPath, "GET", "/framework", undefined);
      const framework = (getRes.body as { framework: { spec?: Record<string, unknown> } | null }).framework;
      if (!framework) {
        deps.stderr("error: no framework document yet -- run `wanfwctl init` first");
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      const updated = { ...framework, spec: { ...framework.spec, strictApprovals: value } };
      await withAdminRequest(deps, "POST", "/framework", updated, () => {
        deps.stdout(`strictApprovals set to '${value}'`);
      });
    });

  program
    .command("init")
    .description("Interactive first-run setup wizard (T5.3): domain, DNS credentials, network provider, framework doc, tier1 setup token")
    .action(async () => {
      process.exitCode = await runInit({
        adminSocketPath: deps.adminSocketPath,
        stdout: deps.stdout,
        stderr: deps.stderr,
        prompt: deps.prompt ?? defaultPrompt,
      });
    });

  program
    .command("doctor")
    .description("Diagnose the running deployment (T5.4): Docker socket, proxy container, network provider, WAN IP vs DNS, DNS provider credentials")
    .action(async () => {
      await withAdminRequest(deps, "GET", "/doctor", undefined, (body) => {
        const checks = (body as { checks: Array<{ name: string; status: string; message: string }> }).checks;
        const symbol: Record<string, string> = { pass: "[pass]", fail: "[FAIL]", warn: "[warn]", info: "[info]", skip: "[skip]" };
        for (const check of checks) {
          deps.stdout(`${symbol[check.status] ?? `[${check.status}]`} ${check.name}: ${check.message}`);
        }
        if (checks.some((c) => c.status === "fail")) {
          process.exitCode = EXIT_CODES.validationFailure;
        }
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
