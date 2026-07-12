import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "./state-store/store.js";
import { FakeDockerClient } from "./execute/fake-docker-client.js";
import { PROXY_CONTAINER_NAME } from "./execute/proxy-container.js";
import { runDoctorChecks, type DoctorCheck } from "./doctor.js";

function find(checks: DoctorCheck[], name: string): DoctorCheck {
  const c = checks.find((c) => c.name === name);
  if (!c) throw new Error(`no check named '${name}' in ${JSON.stringify(checks.map((c) => c.name))}`);
  return c;
}

const bridgeFramework = {
  spec: {
    domain: "example.tld",
    roles: { networkProvider: "network-bridge", proxyEngine: "proxy-caddy", dnsProvider: "dns-namecheap" },
  },
};

const macvlanFramework = {
  spec: {
    domain: "example.tld",
    roles: { networkProvider: "network-macvlan", proxyEngine: "proxy-caddy" },
    network: { macvlan: { parent: "eth0" } },
  },
};

describe("runDoctorChecks (T5.4)", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(async () => {
    stores.splice(0).forEach((s) => s.close());
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  async function freshStore(): Promise<StateStore> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-doctor-"));
    dirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    stores.push(store);
    return store;
  }

  it("docker-socket: pass when the socket path exists, fail when it doesn't", async () => {
    const store = await freshStore();
    const socketDir = await mkdtemp(join(tmpdir(), "wanfw-doctor-sock-"));
    dirs.push(socketDir);
    const realSocket = join(socketDir, "docker.sock");
    await writeFile(realSocket, "");

    const passChecks = await runDoctorChecks({ dockerSocketPath: realSocket, store, docker: new FakeDockerClient() });
    expect(find(passChecks, "docker-socket").status).toBe("pass");

    const failChecks = await runDoctorChecks({ dockerSocketPath: join(socketDir, "nope.sock"), store, docker: new FakeDockerClient() });
    expect(find(failChecks, "docker-socket").status).toBe("fail");
  });

  it("docker-socket: fail when no path is configured at all", async () => {
    const store = await freshStore();
    const checks = await runDoctorChecks({ store, docker: new FakeDockerClient() });
    expect(find(checks, "docker-socket").status).toBe("fail");
  });

  it("framework-doc: fail (and short-circuits every other check) when no framework doc is set", async () => {
    const store = await freshStore();
    const checks = await runDoctorChecks({ store, docker: new FakeDockerClient() });
    expect(find(checks, "framework-doc").status).toBe("fail");
    expect(checks).toHaveLength(2); // docker-socket + framework-doc only
  });

  it("framework-doc: pass once one is set", async () => {
    const store = await freshStore();
    store.setFrameworkDoc(bridgeFramework);
    const checks = await runDoctorChecks({ store, docker: new FakeDockerClient() });
    expect(find(checks, "framework-doc").status).toBe("pass");
  });

  it("proxy-container: pass when running, fail when absent, fail when present but not running", async () => {
    const store = await freshStore();
    store.setFrameworkDoc(bridgeFramework);

    const noneChecks = await runDoctorChecks({ store, docker: new FakeDockerClient() });
    expect(find(noneChecks, "proxy-container").status).toBe("fail");

    const runningDocker = new FakeDockerClient();
    runningDocker.containers.set(PROXY_CONTAINER_NAME, {
      id: "1",
      name: PROXY_CONTAINER_NAME,
      labels: {},
      networks: [],
      state: "running",
    });
    const runningChecks = await runDoctorChecks({ store, docker: runningDocker });
    expect(find(runningChecks, "proxy-container").status).toBe("pass");

    const stoppedDocker = new FakeDockerClient();
    stoppedDocker.containers.set(PROXY_CONTAINER_NAME, {
      id: "1",
      name: PROXY_CONTAINER_NAME,
      labels: {},
      networks: [],
      state: "exited",
    });
    const stoppedChecks = await runDoctorChecks({ store, docker: stoppedDocker });
    expect(find(stoppedChecks, "proxy-container").status).toBe("fail");
  });

  it("macvlan-probe: skipped entirely for a bridge provider", async () => {
    const store = await freshStore();
    store.setFrameworkDoc(bridgeFramework);
    const checks = await runDoctorChecks({ store, docker: new FakeDockerClient() });
    expect(find(checks, "macvlan-probe").status).toBe("skip");
    expect(checks.find((c) => c.name === "macvlan-hairpin-note")).toBeUndefined();
  });

  it("macvlan-probe: pass/fail reflect the real probeNetwork result, plus an info hairpin note", async () => {
    const store = await freshStore();
    store.setFrameworkDoc(macvlanFramework);

    const passChecks = await runDoctorChecks({
      store,
      docker: new FakeDockerClient(),
      probeNetwork: async () => ({ ok: true }),
    });
    expect(find(passChecks, "macvlan-probe").status).toBe("pass");
    expect(find(passChecks, "macvlan-hairpin-note").status).toBe("info");

    const failChecks = await runDoctorChecks({
      store,
      docker: new FakeDockerClient(),
      probeNetwork: async () => ({ ok: false, reason: "no promiscuous mode" }),
    });
    expect(find(failChecks, "macvlan-probe").status).toBe("fail");
    expect(find(failChecks, "macvlan-probe").message).toContain("no promiscuous mode");
  });

  it("macvlan-probe: fail when macvlan is bound but no parent interface is configured", async () => {
    const store = await freshStore();
    store.setFrameworkDoc({ spec: { domain: "example.tld", roles: { networkProvider: "network-macvlan" }, network: {} } });
    const checks = await runDoctorChecks({ store, docker: new FakeDockerClient() });
    expect(find(checks, "macvlan-probe").status).toBe("fail");
  });

  it("wan-ip-detect: pass with a detected IP, fail when detection returns nothing", async () => {
    const store = await freshStore();
    store.setFrameworkDoc(bridgeFramework);

    const passChecks = await runDoctorChecks({ store, docker: new FakeDockerClient(), detectWanIp: async () => "203.0.113.5" });
    expect(find(passChecks, "wan-ip-detect")).toEqual({ name: "wan-ip-detect", status: "pass", message: "detected WAN IP: 203.0.113.5" });

    const failChecks = await runDoctorChecks({ store, docker: new FakeDockerClient(), detectWanIp: async () => undefined });
    expect(find(failChecks, "wan-ip-detect").status).toBe("fail");
  });

  it("dns-record-match: pass when the wildcard resolves to the WAN IP, warn on mismatch, warn on no record", async () => {
    const store = await freshStore();
    store.setFrameworkDoc(bridgeFramework);

    const matching = await runDoctorChecks({
      store,
      docker: new FakeDockerClient(),
      detectWanIp: async () => "203.0.113.5",
      resolveA: async () => ["203.0.113.5"],
    });
    expect(find(matching, "dns-record-match").status).toBe("pass");

    const mismatched = await runDoctorChecks({
      store,
      docker: new FakeDockerClient(),
      detectWanIp: async () => "203.0.113.5",
      resolveA: async () => ["198.51.100.9"],
    });
    expect(find(mismatched, "dns-record-match").status).toBe("warn");

    const noRecord = await runDoctorChecks({
      store,
      docker: new FakeDockerClient(),
      detectWanIp: async () => "203.0.113.5",
      resolveA: async () => [],
    });
    expect(find(noRecord, "dns-record-match").status).toBe("warn");
  });

  it("dns-record-match: skipped when WAN IP wasn't detected, or resolveA isn't available", async () => {
    const store = await freshStore();
    store.setFrameworkDoc(bridgeFramework);

    const noWanIp = await runDoctorChecks({ store, docker: new FakeDockerClient(), resolveA: async () => ["1.2.3.4"] });
    expect(find(noWanIp, "dns-record-match").status).toBe("skip");

    const noResolver = await runDoctorChecks({ store, docker: new FakeDockerClient(), detectWanIp: async () => "203.0.113.5" });
    expect(find(noResolver, "dns-record-match").status).toBe("skip");
  });

  it("dns-provider: skipped when no dnsProvider role is bound, informational when one is", async () => {
    const store = await freshStore();
    store.setFrameworkDoc({ spec: { domain: "example.tld", roles: { networkProvider: "network-bridge" } } });
    const noneChecks = await runDoctorChecks({ store, docker: new FakeDockerClient() });
    expect(find(noneChecks, "dns-provider").status).toBe("skip");

    store.setFrameworkDoc(bridgeFramework);
    const boundChecks = await runDoctorChecks({ store, docker: new FakeDockerClient() });
    expect(find(boundChecks, "dns-provider").status).toBe("info");
    expect(find(boundChecks, "dns-provider").message).toContain("dns-namecheap");
  });
});
