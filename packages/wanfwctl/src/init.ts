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

/** Enter-to-keep-default aware: with no `defaultValue`, behaves exactly like a plain required prompt. */
async function requireAnswer(deps: InitDeps, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  for (;;) {
    const answer = (await deps.prompt(`${question}${suffix}: `)).trim();
    if (answer) return answer;
    if (defaultValue) return defaultValue;
    deps.stdout("  (required)");
  }
}

// Mirrors the pattern constraints in
// packages/core-schemas/src/schemas/framework.schema.json's network fields
// (item 15) -- catching a malformed answer here, with a specific message,
// beats letting it reach POST /framework's Ajv validation as generic noise.
const INTERFACE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const VLAN_ID_PATTERN = /^[0-9]{1,4}$/;
const CIDR_PATTERN = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}\/(3[0-2]|[12]?[0-9])$/;
const IPV4_PATTERN = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;

async function requireMatchingAnswer(deps: InitDeps, question: string, pattern: RegExp, hint: string, defaultValue?: string): Promise<string> {
  for (;;) {
    const answer = await requireAnswer(deps, question, defaultValue);
    if (pattern.test(answer)) return answer;
    deps.stdout(`  invalid format -- ${hint}`);
  }
}

/**
 * A secret-store field that can't be redisplayed (values are never readable
 * back, §12.4). `draftValue` is whatever's been typed so far *this session*
 * (undefined if untouched); `alreadySet` is whether the real secrets store
 * already has a value for this name. Either one makes the field "keep-able"
 * (Enter leaves it alone -- returns `undefined`, meaning "don't re-POST
 * this"); neither makes it required, looping until something's typed.
 */
async function requireOrKeepSecret(deps: InitDeps, question: string, draftValue: string | undefined, alreadySet: boolean): Promise<string | undefined> {
  const canKeep = draftValue !== undefined || alreadySet;
  const hint = canKeep ? " (Enter to keep current)" : "";
  for (;;) {
    const answer = (await deps.prompt(`${question}${hint}: `)).trim();
    if (answer) return answer;
    if (canKeep) return draftValue;
    deps.stdout("  (required)");
  }
}

interface Basics {
  domain: string;
  acmeEmail: string;
}

async function collectBasics(deps: InitDeps, defaults?: Partial<Basics>): Promise<Basics> {
  const domain = await requireAnswer(deps, "Domain (e.g. example.tld)", defaults?.domain);
  const acmeEmail = await requireAnswer(deps, "ACME account email", defaults?.acmeEmail);
  return { domain, acmeEmail };
}

interface DnsDraft {
  apiUser?: string;
  username?: string;
  apiKey?: string;
}

interface DnsAlreadySet {
  apiUser: boolean;
  username: boolean;
  apiKey: boolean;
}

async function collectDns(deps: InitDeps, draft: DnsDraft, alreadySet: DnsAlreadySet): Promise<DnsDraft> {
  deps.stdout("\nDNS provider credentials (Namecheap) -- stored via the secrets store, never logged.");
  deps.stdout("  API User: the Namecheap account enabled for API access (enable this under Namecheap's");
  deps.stdout("    Profile > Tools > API Access).");
  const apiUser = await requireOrKeepSecret(deps, "  Namecheap API user", draft.apiUser, alreadySet.apiUser);
  deps.stdout("  Username: the account that owns/manages the domain -- almost always the same value as");
  deps.stdout("    API User (only differs for reseller/sub-account setups). If unsure, enter it again.");
  const username = await requireOrKeepSecret(deps, "  Namecheap username", draft.username, alreadySet.username);
  const apiKey = await requireOrKeepSecret(deps, "  Namecheap API key", draft.apiKey, alreadySet.apiKey);
  return { apiUser, username, apiKey };
}

interface NetworkDraft {
  useMacvlan: boolean;
  vlanSegmented?: boolean;
  baseInterface?: string;
  vlanId?: string;
  parent?: string; // only set on the plain (non-VLAN) path -- the VLAN path derives it from baseInterface+vlanId
  reservedCidr?: string;
  gateway?: string;
}

interface NetworkResult {
  networkProvider: string;
  network: Record<string, unknown>;
  draft: NetworkDraft;
}

async function collectNetwork(deps: InitDeps, draft: NetworkDraft): Promise<NetworkResult> {
  deps.stdout("\nNetwork provider: bridge (default, publishes 443/80 on the host) or macvlan (dedicated LAN IP).");
  deps.stdout("  See docs/operator-guide.md §5 for the full macvlan networking explanation.");
  const useMacvlan = await askYesNo(deps, "Use macvlan?", draft.useMacvlan);
  if (!useMacvlan) {
    return { networkProvider: "network-bridge", network: { lanInterface: "eth0" }, draft: { useMacvlan: false } };
  }

  deps.stdout(
    "  If your switch tags a VLAN for this host's LAN, the container needs the VLAN sub-interface" +
      " (e.g. base 'eth0', VLAN 50 -> 'eth0.50'), not the parent physical interface.",
  );
  const vlanSegmented = await askYesNo(deps, "  Is your LAN VLAN-segmented?", draft.vlanSegmented ?? Boolean(draft.baseInterface));
  let parent: string;
  let baseInterface: string | undefined;
  let vlanId: string | undefined;
  if (vlanSegmented) {
    baseInterface = await requireMatchingAnswer(
      deps,
      "    Base interface (e.g. eth0 -- check with `ip route` on the host)",
      INTERFACE_NAME_PATTERN,
      "an interface name looks like 'eth0' or 'enp3s0' (letters/digits/hyphens, starting with a letter)",
      draft.baseInterface,
    );
    vlanId = await requireMatchingAnswer(deps, "    VLAN ID (e.g. 50)", VLAN_ID_PATTERN, "a VLAN ID is 1-4 digits, e.g. 50", draft.vlanId);
    parent = `${baseInterface}.${vlanId}`;
    deps.stdout(`    using '${parent}' as the macvlan parent interface`);
  } else {
    parent = await requireMatchingAnswer(
      deps,
      "  Host LAN interface (e.g. eth0 -- check with `ip route` on the host)",
      INTERFACE_NAME_PATTERN,
      "an interface name looks like 'eth0' or 'enp3s0' (letters/digits/hyphens, starting with a letter)",
      draft.parent,
    );
  }
  const reservedCidr = await requireMatchingAnswer(
    deps,
    "  Reserved CIDR slice outside your DHCP pool (e.g. 192.168.1.240/29)",
    CIDR_PATTERN,
    "a CIDR looks like '192.168.1.240/29'",
    draft.reservedCidr,
  );
  const gateway = await requireMatchingAnswer(
    deps,
    "  LAN gateway IP (e.g. 192.168.1.1)",
    IPV4_PATTERN,
    "an IPv4 address looks like '192.168.1.1'",
    draft.gateway,
  );

  return {
    networkProvider: "network-macvlan",
    network: { lanInterface: parent, macvlan: { parent, reservedCidr, gateway } },
    draft: { useMacvlan: true, vlanSegmented, baseInterface, vlanId, parent: vlanSegmented ? undefined : parent, reservedCidr, gateway },
  };
}

function describeNetwork(networkProvider: string, network: Record<string, unknown>): string {
  if (networkProvider !== "network-macvlan") return "bridge (default, publishes 443/80 on the host)";
  const macvlan = network.macvlan as { parent: string; reservedCidr: string; gateway: string };
  return `macvlan on '${macvlan.parent}', CIDR ${macvlan.reservedCidr}, gateway ${macvlan.gateway}`;
}

function describeDnsField(value: string | undefined): string {
  return value !== undefined ? "new value provided" : "unchanged (already set)";
}

function printReview(deps: InitDeps, basics: Basics, dns: DnsDraft, net: NetworkResult): void {
  deps.stdout("\n--- Review ---");
  deps.stdout(`1) Domain & ACME email: ${basics.domain} / ${basics.acmeEmail}`);
  deps.stdout(
    `2) DNS credentials (Namecheap): api-user (${describeDnsField(dns.apiUser)}), ` +
      `username (${describeDnsField(dns.username)}), api-key (${describeDnsField(dns.apiKey)})`,
  );
  deps.stdout(`3) Network: ${describeNetwork(net.networkProvider, net.network)}`);
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
 * Re-running against an existing framework document prefills every field
 * as a default (Enter keeps it); DNS secrets can't be read back, so those
 * fields instead offer "Enter to keep current" once the secrets store
 * already has a value, based on a `GET /secrets` presence check, never the
 * value itself. Before committing, a review step lists every section and
 * lets the operator jump back and re-run just one (domain/DNS/network)
 * rather than restarting the whole wizard -- including recovering from a
 * failed macvlan probe by looping back to fix the network section instead
 * of aborting outright.
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
  const existingSpec = (existing.body as { framework?: { spec?: Record<string, unknown> } }).framework?.spec;
  if (existingSpec) {
    const proceed = await askYesNo(
      deps,
      "A framework document already exists. Edit it? (existing values are offered as defaults -- press Enter to keep them)",
      false,
    );
    if (!proceed) {
      deps.stdout("aborted");
      return 0;
    }
  }

  const secretsRes = await adminRequest(deps.adminSocketPath, "GET", "/secrets").catch(() => undefined);
  const secretNames = new Set(((secretsRes?.body as { secrets?: Array<{ name: string }> } | undefined)?.secrets ?? []).map((s) => s.name));
  const dnsAlreadySet: DnsAlreadySet = {
    apiUser: secretNames.has("dns-namecheap/api-user"),
    username: secretNames.has("dns-namecheap/username"),
    apiKey: secretNames.has("dns-namecheap/api-key"),
  };

  let basics = await collectBasics(deps, existingSpec as Partial<Basics> | undefined);
  let dns = await collectDns(deps, {}, dnsAlreadySet);
  let net = await collectNetwork(deps, deriveNetworkDraft(existingSpec));

  for (;;) {
    printReview(deps, basics, dns, net);
    const choice = (await deps.prompt("Proceed? [Y] or enter 1/2/3 to edit that section, or 'q' to abort: ")).trim().toLowerCase();

    if (choice === "q") {
      deps.stdout("aborted");
      return 0;
    }
    if (choice === "1") {
      basics = await collectBasics(deps, basics);
      continue;
    }
    if (choice === "2") {
      dns = await collectDns(deps, dns, dnsAlreadySet);
      continue;
    }
    if (choice === "3") {
      net = await collectNetwork(deps, net.draft);
      continue;
    }
    if (choice && choice !== "y" && choice !== "yes") {
      deps.stdout("  unrecognized choice");
      continue;
    }

    if (net.networkProvider === "network-macvlan") {
      const parent = (net.network.macvlan as { parent: string }).parent;
      deps.stdout(`\nProbing macvlan feasibility on '${parent}'...`);
      const probeRes = await adminRequest(deps.adminSocketPath, "POST", "/network/probe-macvlan", { parent });
      const probe = probeRes.body as { ok?: boolean; reason?: string };
      if (!probe.ok) {
        deps.stdout(
          `  macvlan is not usable on '${parent}'${probe.reason ? `: ${probe.reason}` : ""} -- ` +
            "enter 3 to fix the network section, or 'q' to abort.",
        );
        continue;
      }
      deps.stdout("  macvlan probe passed.");
    }
    break;
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
    ["dns-namecheap/api-user", dns.apiUser],
    ["dns-namecheap/username", dns.username],
    ["dns-namecheap/api-key", dns.apiKey],
  ] as const) {
    if (value === undefined) continue; // operator kept the existing store value unchanged
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
      domain: basics.domain,
      deploymentMode: "subdomain",
      acmeEmail: basics.acmeEmail,
      roles: {
        networkProvider: net.networkProvider,
        proxyEngine: "proxy-caddy",
        dnsProvider: "dns-namecheap",
        certIssuer: "cert-letsencrypt-dns01",
      },
      network: net.network,
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
    net.networkProvider === "network-macvlan"
      ? "Forward WAN:443 (and :80) to the proxy's macvlan IP -- run `wanfwctl plugin invoke network-macvlan network.plan '{...}'` or check `wanfwctl status` for the exact address once allocated."
      : "Forward WAN:443 (and :80) to this host's LAN IP.";
  const dnsInstruction = `Point DNS: *.${basics.domain} A ${wanIp ?? "<your WAN IP>"}`;

  // T5.5: mirrored read-only onto tier1's setup page (via GET
  // /operator-info) so the operator isn't relying on terminal scrollback
  // to find these again later.
  await adminRequest(deps.adminSocketPath, "POST", "/operator-info", {
    domain: basics.domain,
    wanIp: wanIp ?? null,
    networkProvider: net.networkProvider,
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

/** Splits an existing framework doc's network config back into the same NetworkDraft shape collectNetwork's own edit path consumes, so re-running init prefills a VLAN-composed parent (e.g. 'eth0.50') as base-interface + VLAN-ID, not a single opaque string. */
function deriveNetworkDraft(existingSpec: Record<string, unknown> | undefined): NetworkDraft {
  const roles = existingSpec?.roles as { networkProvider?: string } | undefined;
  if (roles?.networkProvider !== "network-macvlan") return { useMacvlan: false };

  const network = existingSpec?.network as { macvlan?: { parent?: string; reservedCidr?: string; gateway?: string } } | undefined;
  const macvlan = network?.macvlan;
  if (!macvlan?.parent) return { useMacvlan: true };

  const dotIdx = macvlan.parent.indexOf(".");
  if (dotIdx === -1) {
    return { useMacvlan: true, vlanSegmented: false, parent: macvlan.parent, reservedCidr: macvlan.reservedCidr, gateway: macvlan.gateway };
  }
  return {
    useMacvlan: true,
    vlanSegmented: true,
    baseInterface: macvlan.parent.slice(0, dotIdx),
    vlanId: macvlan.parent.slice(dotIdx + 1),
    reservedCidr: macvlan.reservedCidr,
    gateway: macvlan.gateway,
  };
}
