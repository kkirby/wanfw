import { existsSync } from "node:fs";
import type { StateStore } from "./state-store/store.js";
import type { DockerClient } from "./execute/docker-client.js";
import { PROXY_CONTAINER_NAME } from "./execute/proxy-container.js";

export type DoctorStatus = "pass" | "fail" | "warn" | "info" | "skip";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorDeps {
  dockerSocketPath?: string;
  store: StateStore;
  docker?: DockerClient;
  /** Real Docker-daemon-backed macvlan feasibility check (T5.2's `probeMacvlan`), injected so the check is testable without a live daemon. */
  probeNetwork?: (mode: "macvlan", parent: string) => Promise<{ ok: boolean; reason?: string }>;
  /** pluginhost's `helper.wanIp`/`helper.resolveA` RPCs, injected so doctor is testable without a live pluginhost connection. */
  detectWanIp?: () => Promise<string | undefined>;
  resolveA?: (hostname: string) => Promise<string[]>;
}

/**
 * `wanfwctl doctor` (T5.4, §11, §13): every check reports one of
 * `pass`/`fail`/`warn`/`info`/`skip` plus a human-actionable message,
 * never just a boolean -- "structured and actionable" per the plan's own
 * "Done when." Checks that don't apply to the current configuration
 * (e.g. the macvlan probe when the framework is bound to `network-bridge`)
 * report `skip` with a reason, not silently omitted -- an operator
 * running doctor should see the full checklist every time, not wonder
 * why a line disappeared.
 */
export async function runDoctorChecks(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. Docker socket reachability -- the orchestrator's own defining
  // capability (§12.5: it's the one holder of /var/run/docker.sock among
  // framework containers).
  if (!deps.dockerSocketPath) {
    checks.push({ name: "docker-socket", status: "fail", message: "no Docker socket path configured" });
  } else if (existsSync(deps.dockerSocketPath)) {
    checks.push({ name: "docker-socket", status: "pass", message: `Docker socket reachable at ${deps.dockerSocketPath}` });
  } else {
    checks.push({ name: "docker-socket", status: "fail", message: `Docker socket not found at ${deps.dockerSocketPath}` });
  }

  // 2. Framework document exists.
  const frameworkRaw = deps.store.getFrameworkDoc();
  if (!frameworkRaw) {
    checks.push({ name: "framework-doc", status: "fail", message: "no framework document set -- run `wanfwctl init`" });
    return checks; // every check below needs the framework doc's roles/domain
  }
  checks.push({ name: "framework-doc", status: "pass", message: "framework document is set" });

  const framework = frameworkRaw as {
    spec?: { domain?: string; roles?: Record<string, string>; network?: { macvlan?: { parent?: string } } };
  };
  const domain = framework.spec?.domain;
  const roles = framework.spec?.roles ?? {};
  const networkProvider = roles.networkProvider;
  const dnsProvider = roles.dnsProvider;

  // 3. Proxy container running.
  const docker = deps.docker;
  if (!docker) {
    checks.push({ name: "proxy-container", status: "skip", message: "Docker client unavailable in this environment" });
  } else {
    try {
      const proxy = await docker.findManagedContainerByName(PROXY_CONTAINER_NAME);
      if (!proxy) {
        checks.push({ name: "proxy-container", status: "fail", message: "wanfw-proxy container does not exist yet -- check `wanfwctl status`" });
      } else if (proxy.state === "running") {
        checks.push({ name: "proxy-container", status: "pass", message: "wanfw-proxy is running" });
      } else {
        checks.push({ name: "proxy-container", status: "fail", message: `wanfw-proxy exists but is not running (state: ${proxy.state})` });
      }
    } catch (err) {
      checks.push({ name: "proxy-container", status: "fail", message: `could not query wanfw-proxy: ${(err as Error).message}` });
    }
  }

  // 4. macvlan capability probe (only when macvlan is the bound provider).
  if (networkProvider === "network-macvlan") {
    const parent = framework.spec?.network?.macvlan?.parent;
    if (!parent) {
      checks.push({ name: "macvlan-probe", status: "fail", message: "network-macvlan is bound but no parent interface is configured" });
    } else if (!deps.probeNetwork) {
      checks.push({ name: "macvlan-probe", status: "skip", message: "macvlan probing unavailable in this environment" });
    } else {
      const result = await deps.probeNetwork("macvlan", parent);
      checks.push(
        result.ok
          ? { name: "macvlan-probe", status: "pass", message: `macvlan is usable on interface '${parent}'` }
          : { name: "macvlan-probe", status: "fail", message: result.reason ?? `macvlan is not usable on '${parent}'` },
      );
    }
    checks.push({
      name: "macvlan-hairpin-note",
      status: "info",
      message: "macvlan is active: the host itself cannot reach the proxy's dedicated IP without a shim interface (see the plan's own operatorInstructions for the exact `ip link add ... type macvlan` recipe). This affects operator debugging only -- health checks and reloads run over the service networks, never the exposure IP.",
    });
  } else {
    checks.push({ name: "macvlan-probe", status: "skip", message: `network provider is '${networkProvider ?? "unset"}', not network-macvlan` });
  }

  // 5. WAN IP detection.
  let wanIp: string | undefined;
  if (!deps.detectWanIp) {
    checks.push({ name: "wan-ip-detect", status: "skip", message: "WAN IP detection unavailable in this environment" });
  } else {
    try {
      wanIp = await deps.detectWanIp();
      checks.push(
        wanIp
          ? { name: "wan-ip-detect", status: "pass", message: `detected WAN IP: ${wanIp}` }
          : { name: "wan-ip-detect", status: "fail", message: "could not detect WAN IP" },
      );
    } catch (err) {
      checks.push({ name: "wan-ip-detect", status: "fail", message: `WAN IP detection failed: ${(err as Error).message}` });
    }
  }

  // 6. WAN IP vs DNS record comparison.
  if (!domain) {
    checks.push({ name: "dns-record-match", status: "skip", message: "no domain configured" });
  } else if (!deps.resolveA) {
    checks.push({ name: "dns-record-match", status: "skip", message: "DNS resolution unavailable in this environment" });
  } else if (!wanIp) {
    checks.push({ name: "dns-record-match", status: "skip", message: "WAN IP not detected, cannot compare" });
  } else {
    const probeHost = `wanfw-doctor-probe.${domain}`;
    const addresses = await deps.resolveA(probeHost).catch((): string[] => []);
    if (addresses.length === 0) {
      checks.push({
        name: "dns-record-match",
        status: "warn",
        message: `no A record found for a *.${domain} test name -- point your wildcard DNS record at ${wanIp} if you haven't yet`,
      });
    } else if (addresses.includes(wanIp)) {
      checks.push({ name: "dns-record-match", status: "pass", message: `*.${domain} resolves to the detected WAN IP (${wanIp})` });
    } else {
      checks.push({
        name: "dns-record-match",
        status: "warn",
        message: `*.${domain} resolves to ${addresses.join(", ")}, not the detected WAN IP (${wanIp}) -- DNS may still be propagating`,
      });
    }
  }

  // 7. DNS provider credentials present (structural, not a live API call --
  // a real reachability check would need per-provider knowledge this
  // module deliberately doesn't have).
  if (!dnsProvider) {
    checks.push({ name: "dns-provider", status: "skip", message: "no dnsProvider role bound" });
  } else {
    checks.push({ name: "dns-provider", status: "info", message: `dnsProvider bound to '${dnsProvider}' -- run \`wanfwctl secret list\` to confirm its credentials are set` });
  }

  return checks;
}
