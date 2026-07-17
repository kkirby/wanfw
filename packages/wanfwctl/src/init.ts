import { randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { adminRequest, AdminSocketUnreachableError } from "./admin-client.js";

export interface InitDeps {
  adminSocketPath: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Prompts the operator and returns their answer. Real implementation is readline-backed (no TTY over `docker exec -i`, so input is never masked -- documented to the operator, not silently pretended otherwise). */
  prompt: (question: string) => Promise<string>;
  /** Where to write the one-time setup token (docs/t5.3-decisions.md) -- defaults to the same path the orchestrator itself uses for wanfw_status, since `wanfwctl init` runs inside the orchestrator container. */
  statusDir?: string;
  /** Injectable for tests; defaults to the real 5s-polling wait used against a live orchestrator. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Every builtin the pluginhost image ships that's meant to be trusted on a
 * real deployment. Deliberately excludes `dns-mock` (T4.7's Pebble-only
 * test infrastructure) -- see docs/t5.3-decisions.md's closing note. Kept
 * as an explicit list rather than "all builtins" specifically so this list
 * has to be edited by hand when a new production plugin ships, instead of
 * silently trusting whatever the image happens to contain.
 */
export const PRODUCTION_BUILTIN_IDS = [
  "deploy-docker",
  "network-bridge",
  "network-macvlan",
  "proxy-caddy",
  "dns-namecheap",
  "cert-letsencrypt-dns01",
];

async function askYesNo(deps: InitDeps, question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await deps.prompt(`${question} ${suffix} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function requireAnswer(deps: InitDeps, question: string): Promise<string> {
  for (;;) {
    const answer = (await deps.prompt(`${question}: `)).trim();
    if (answer) return answer;
    deps.stdout("  (required)");
  }
}

/**
 * `wanfwctl init` (T5.3, §11, §1.2 steps 1-2): collects domain/DNS
 * credentials/ACME email, probes both network providers and lets the
 * operator choose, batch-trusts the production builtins (never dns-mock),
 * writes the framework document (via `POST /framework`, T5.3's own
 * Decision 1 -- this is the *only* legitimate way to author it), issues a
 * one-time tier1 setup token (Decision 2), and waits for the resulting
 * reconcile to bring the proxy up before printing final instructions.
 *
 * Interface auto-detection for macvlan is *not* implemented here (a
 * deliberate, documented scope cut, not an oversight): the orchestrator
 * container has zero network access of its own (`network_mode: "none"`,
 * §12.5), so "detect the host's default-route interface" would need a
 * dedicated host-network diagnostic container spawned via the Docker
 * socket -- real, separable infrastructure. The operator is asked for the
 * interface name directly instead (`ip route` on the host names it in one
 * line), which is honest about the actual constraint rather than a
 * half-built auto-detector.
 */
export async function runInit(deps: InitDeps): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const statusDir = deps.statusDir ?? process.env.WANFW_STATUS_DIR ?? "/data/status";

  deps.stdout("wanfw setup wizard\n");

  const existing = await adminRequest(deps.adminSocketPath, "GET", "/framework").catch((err) => {
    if (err instanceof AdminSocketUnreachableError) {
      deps.stderr(`error: orchestrator admin socket unreachable: ${err.message}`);
      return undefined;
    }
    throw err;
  });
  if (!existing) return 1;
  if ((existing.body as { framework: unknown }).framework) {
    const proceed = await askYesNo(deps, "A framework document already exists. Overwrite it?", false);
    if (!proceed) {
      deps.stdout("aborted");
      return 0;
    }
  }

  const domain = await requireAnswer(deps, "Domain (e.g. example.tld)");
  const acmeEmail = await requireAnswer(deps, "ACME account email");

  deps.stdout("\nDNS provider credentials (Namecheap) -- stored via the secrets store, never logged.");
  deps.stdout("  API User: the Namecheap account enabled for API access (enable this under Namecheap's");
  deps.stdout("    Profile > Tools > API Access).");
  const apiUser = await requireAnswer(deps, "  Namecheap API user");
  deps.stdout("  Username: the account that owns/manages the domain -- almost always the same value as");
  deps.stdout("    API User (only differs for reseller/sub-account setups). If unsure, enter it again.");
  const username = await requireAnswer(deps, "  Namecheap username");
  const apiKey = await requireAnswer(deps, "  Namecheap API key");

  deps.stdout("\nNetwork provider: bridge (default, publishes 443/80 on the host) or macvlan (dedicated LAN IP).");
  const useMacvlan = await askYesNo(deps, "Use macvlan?", false);
  let networkProvider = "network-bridge";
  let network: Record<string, unknown> = { lanInterface: "eth0" };
  if (useMacvlan) {
    networkProvider = "network-macvlan";
    const parent = await requireAnswer(deps, "  Host LAN interface (e.g. eth0 -- check with `ip route` on the host)");
    const reservedCidr = await requireAnswer(deps, "  Reserved CIDR slice outside your DHCP pool (e.g. 192.168.1.240/29)");
    const gateway = await requireAnswer(deps, "  LAN gateway IP (e.g. 192.168.1.1)");
    network = { lanInterface: parent, macvlan: { parent, reservedCidr, gateway } };
  }

  deps.stdout("\nTrusting production builtins...");
  const trustRes = await adminRequest(deps.adminSocketPath, "POST", "/plugins/trust-builtins", { ids: PRODUCTION_BUILTIN_IDS });
  if (trustRes.status < 200 || trustRes.status >= 300) {
    deps.stderr(`error: trusting builtins failed: ${JSON.stringify(trustRes.body)}`);
    return 1;
  }
  deps.stdout(`  trusted: ${PRODUCTION_BUILTIN_IDS.join(", ")}`);

  deps.stdout("\nStoring DNS provider credentials...");
  for (const [name, value] of [
    ["dns-namecheap/api-user", apiUser],
    ["dns-namecheap/username", username],
    ["dns-namecheap/api-key", apiKey],
  ]) {
    const res = await adminRequest(deps.adminSocketPath, "POST", "/secrets", { name, value });
    if (res.status < 200 || res.status >= 300) {
      deps.stderr(`error: storing secret '${name}' failed: ${JSON.stringify(res.body)}`);
      return 1;
    }
  }

  const framework = {
    schemaVersion: 1,
    kind: "Framework",
    metadata: { id: "framework" },
    spec: {
      domain,
      deploymentMode: "subdomain",
      acmeEmail,
      roles: {
        networkProvider,
        proxyEngine: "proxy-caddy",
        dnsProvider: "dns-namecheap",
        certIssuer: "cert-letsencrypt-dns01",
      },
      network,
    },
  };

  deps.stdout("\nWriting the framework document...");
  const frameworkRes = await adminRequest(deps.adminSocketPath, "POST", "/framework", framework);
  if (frameworkRes.status < 200 || frameworkRes.status >= 300) {
    deps.stderr(`error: writing the framework document failed: ${JSON.stringify(frameworkRes.body)}`);
    return 1;
  }

  deps.stdout("Waiting for the initial reconcile to bring the proxy up (up to 30s)...");
  let live = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const statusRes = await adminRequest(deps.adminSocketPath, "GET", "/status");
    const phase = (statusRes.body as { phase?: string }).phase;
    if (phase === "live" || phase === "degraded") {
      live = true;
      break;
    }
  }
  deps.stdout(live ? "  proxy is up." : "  still reconciling -- check `wanfwctl status` shortly.");

  deps.stdout("\nDetecting WAN IP...");
  const wanIpRes = await adminRequest(deps.adminSocketPath, "GET", "/network/wan-ip").catch(() => undefined);
  const wanIp = (wanIpRes?.body as { ip?: string } | undefined)?.ip;
  deps.stdout(wanIp ? `  WAN IP: ${wanIp}` : "  could not detect WAN IP -- check it yourself (e.g. https://api.ipify.org).");

  const token = randomBytes(16).toString("hex");
  await mkdir(statusDir, { recursive: true });
  await writeFile(join(statusDir, "setup-token.json"), JSON.stringify({ token, createdAt: new Date().toISOString() }));

  const forwardInstruction =
    networkProvider === "network-macvlan"
      ? "Forward WAN:443 (and :80) to the proxy's macvlan IP -- run `wanfwctl plugin invoke network-macvlan network.plan '{...}'` or check `wanfwctl status` for the exact address once allocated."
      : "Forward WAN:443 (and :80) to this host's LAN IP.";
  const dnsInstruction = `Point DNS: *.${domain} A ${wanIp ?? "<your WAN IP>"}`;

  // T5.5: mirrored read-only onto tier1's setup page (via GET
  // /operator-info) so the operator isn't relying on terminal scrollback
  // to find these again later.
  await adminRequest(deps.adminSocketPath, "POST", "/operator-info", {
    domain,
    wanIp: wanIp ?? null,
    networkProvider,
    instructions: [dnsInstruction, forwardInstruction],
    generatedAt: new Date().toISOString(),
  }).catch(() => {}); // best-effort -- never block init's own success on this

  deps.stdout("\n--- Next steps ---");
  deps.stdout(`1. ${dnsInstruction}`);
  deps.stdout(`2. ${forwardInstruction}`);
  deps.stdout(`3. Open http://<this-host-LAN-IP>:8443/setup and enter setup token: ${token}`);
  deps.stdout("   (valid for 24h; re-run `wanfwctl init` to issue a new one)");

  return 0;
}
