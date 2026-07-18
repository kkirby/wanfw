import { describe, expect, it, afterEach } from "vitest";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { listenOnUnixSocket } from "./uds-server.js";
import { buildAdminSocketRouter } from "./admin-socket.js";
import type { HeartbeatState } from "./heartbeat.js";
import { StateStore } from "./state-store/store.js";
import { SigningKeyManager } from "./signing-key.js";
import { AuditLog } from "./audit-log.js";

function requestOverSocket(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const validFramework = {
  schemaVersion: 1,
  kind: "Framework",
  metadata: { id: "framework" },
  spec: {
    domain: "example.tld",
    deploymentMode: "subdomain",
    acmeEmail: "ops@example.tld",
    roles: { networkProvider: "network-bridge", proxyEngine: "proxy-caddy" },
  },
};

describe("admin socket: /framework (T5.3, docs/t5.3-decisions.md)", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];
  const stores: StateStore[] = [];

  afterEach(async () => {
    servers.splice(0).forEach((s) => s.close());
    stores.splice(0).forEach((s) => s.close());
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  async function boot(onFrameworkChange?: () => void, connection?: { call: (method: string, params?: unknown) => Promise<unknown> }) {
    const heartbeat: HeartbeatState = { current: { phase: "pending-init", ts: "x", version: "0.1.0" } };
    const dbDir = await mkdtemp(join(tmpdir(), "wanfw-admin-state-"));
    dirs.push(dbDir);
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);

    const keyDir = await mkdtemp(join(tmpdir(), "wanfw-admin-key-"));
    dirs.push(keyDir);
    const signingKeyHolder = { manager: await SigningKeyManager.loadOrCreate(join(keyDir, "signing.key")), keyPath: join(keyDir, "signing.key") };

    const auditDir = await mkdtemp(join(tmpdir(), "wanfw-admin-audit-"));
    dirs.push(auditDir);
    const auditLog = new AuditLog(join(auditDir, "audit.jsonl"), () => signingKeyHolder.manager);

    const stagingDir = await mkdtemp(join(tmpdir(), "wanfw-admin-staging-"));
    dirs.push(stagingDir);
    const bundlesDir = await mkdtemp(join(tmpdir(), "wanfw-admin-bundles-"));
    dirs.push(bundlesDir);
    const statusDir = await mkdtemp(join(tmpdir(), "wanfw-admin-status-"));
    dirs.push(statusDir);
    const secretsDir = await mkdtemp(join(tmpdir(), "wanfw-admin-secrets-"));
    dirs.push(secretsDir);
    const certsDir = await mkdtemp(join(tmpdir(), "wanfw-admin-certs-"));
    dirs.push(certsDir);
    const socketDir = await mkdtemp(join(tmpdir(), "wanfw-admin-sock-"));
    dirs.push(socketDir);

    const router = buildAdminSocketRouter({
      heartbeat,
      signingKeyHolder,
      store,
      auditLog,
      pluginConnectionHolder: { connection: connection as never },
      stagingDir,
      bundlesDir,
      statusDir,
      secretsDir,
      certsDir,
      gateSnapshotHolder: { services: new Map() },
      onFrameworkChange,
    });
    const socketPath = join(socketDir, "admin.sock");
    const server = listenOnUnixSocket(router, socketPath, 0o600);
    servers.push(server);
    await new Promise((r) => setTimeout(r, 50));
    return { socketPath, store, auditLog };
  }

  it("GET /framework returns null before anything has ever been set", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "GET", "/framework");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ framework: null });
  });

  it("POST /framework with a valid doc stores it, audits it, and triggers onFrameworkChange", async () => {
    let fired = false;
    const { socketPath, store, auditLog } = await boot(() => {
      fired = true;
    });

    const res = await requestOverSocket(socketPath, "POST", "/framework", validFramework);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ set: true });
    expect(fired).toBe(true);
    expect(store.getFrameworkDoc()).toEqual(validFramework);
    expect(auditLog.verify().valid).toBe(true);

    const getRes = await requestOverSocket(socketPath, "GET", "/framework");
    expect(getRes.body).toEqual({ framework: validFramework });
  });

  it("POST /framework with an invalid doc is rejected with a structured error, and never stored", async () => {
    const { socketPath, store } = await boot();
    const res = await requestOverSocket(socketPath, "POST", "/framework", { kind: "Framework" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid");
    expect(store.getFrameworkDoc()).toBeUndefined();
  });

  it("POST /framework with no body is a usage error", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "POST", "/framework");
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("usage");
  });

  it("POST /framework accepts a VLAN sub-interface (e.g. 'eth0.50') as a valid macvlan parent/lanInterface", async () => {
    const { socketPath, store } = await boot();
    const vlanFramework = {
      ...validFramework,
      spec: {
        ...validFramework.spec,
        roles: { networkProvider: "network-macvlan", proxyEngine: "proxy-caddy" },
        network: {
          lanInterface: "eth0.50",
          macvlan: { parent: "eth0.50", reservedCidr: "192.168.1.240/29", gateway: "192.168.1.1" },
        },
      },
    };
    const res = await requestOverSocket(socketPath, "POST", "/framework", vlanFramework);
    expect(res.status).toBe(200);
    expect(store.getFrameworkDoc()).toEqual(vlanFramework);
  });

  it("POST /framework rejects a malformed reservedCidr/gateway/parent before ever storing it", async () => {
    const { socketPath, store } = await boot();
    const base = {
      ...validFramework,
      spec: {
        ...validFramework.spec,
        roles: { networkProvider: "network-macvlan", proxyEngine: "proxy-caddy" },
      },
    };

    const badCidr = { ...base, spec: { ...base.spec, network: { lanInterface: "eth0", macvlan: { parent: "eth0", reservedCidr: "not-a-cidr", gateway: "192.168.1.1" } } } };
    expect((await requestOverSocket(socketPath, "POST", "/framework", badCidr)).status).toBe(400);

    const badGateway = { ...base, spec: { ...base.spec, network: { lanInterface: "eth0", macvlan: { parent: "eth0", reservedCidr: "192.168.1.240/29", gateway: "999.999.999.999" } } } };
    expect((await requestOverSocket(socketPath, "POST", "/framework", badGateway)).status).toBe(400);

    const badParent = { ...base, spec: { ...base.spec, network: { lanInterface: "eth0", macvlan: { parent: "not an interface!", reservedCidr: "192.168.1.240/29", gateway: "192.168.1.1" } } } };
    expect((await requestOverSocket(socketPath, "POST", "/framework", badParent)).status).toBe(400);

    expect(store.getFrameworkDoc()).toBeUndefined();
  });

  it("a second POST /framework overwrites the first", async () => {
    const { socketPath, store } = await boot();
    await requestOverSocket(socketPath, "POST", "/framework", validFramework);
    const second = { ...validFramework, spec: { ...validFramework.spec, domain: "second.tld" } };
    await requestOverSocket(socketPath, "POST", "/framework", second);
    expect((store.getFrameworkDoc() as { spec: { domain: string } }).spec.domain).toBe("second.tld");
  });
});

describe("admin socket: /operator-info (T5.5)", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];
  const stores: StateStore[] = [];

  afterEach(async () => {
    servers.splice(0).forEach((s) => s.close());
    stores.splice(0).forEach((s) => s.close());
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  async function boot() {
    const heartbeat: HeartbeatState = { current: { phase: "pending-init", ts: "x", version: "0.1.0" } };
    const dbDir = await mkdtemp(join(tmpdir(), "wanfw-admin-state-"));
    dirs.push(dbDir);
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const keyDir = await mkdtemp(join(tmpdir(), "wanfw-admin-key-"));
    dirs.push(keyDir);
    const signingKeyHolder = { manager: await SigningKeyManager.loadOrCreate(join(keyDir, "signing.key")), keyPath: join(keyDir, "signing.key") };
    const auditDir = await mkdtemp(join(tmpdir(), "wanfw-admin-audit-"));
    dirs.push(auditDir);
    const auditLog = new AuditLog(join(auditDir, "audit.jsonl"), () => signingKeyHolder.manager);
    const stagingDir = await mkdtemp(join(tmpdir(), "wanfw-admin-staging-"));
    dirs.push(stagingDir);
    const bundlesDir = await mkdtemp(join(tmpdir(), "wanfw-admin-bundles-"));
    dirs.push(bundlesDir);
    const statusDir = await mkdtemp(join(tmpdir(), "wanfw-admin-status-"));
    dirs.push(statusDir);
    const secretsDir = await mkdtemp(join(tmpdir(), "wanfw-admin-secrets-"));
    dirs.push(secretsDir);
    const certsDir = await mkdtemp(join(tmpdir(), "wanfw-admin-certs-"));
    dirs.push(certsDir);
    const socketDir = await mkdtemp(join(tmpdir(), "wanfw-admin-sock-"));
    dirs.push(socketDir);
    const router = buildAdminSocketRouter({
      heartbeat,
      signingKeyHolder,
      store,
      auditLog,
      pluginConnectionHolder: {},
      stagingDir,
      bundlesDir,
      statusDir,
      secretsDir,
      certsDir,
      gateSnapshotHolder: { services: new Map() },
    });
    const socketPath = join(socketDir, "admin.sock");
    const server = listenOnUnixSocket(router, socketPath, 0o600);
    servers.push(server);
    await new Promise((r) => setTimeout(r, 50));
    return { socketPath, store };
  }

  it("GET /operator-info returns null before anything has ever been set", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "GET", "/operator-info");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ operatorInfo: null });
  });

  it("POST /operator-info stores it and audits it, GET mirrors it back", async () => {
    const { socketPath, store } = await boot();
    const info = { domain: "example.tld", wanIp: "203.0.113.5", networkProvider: "network-bridge", instructions: ["forward WAN:443 -> LAN IP"] };
    const res = await requestOverSocket(socketPath, "POST", "/operator-info", info);
    expect(res.status).toBe(200);
    expect(store.getOperatorInfo()).toEqual(info);

    const getRes = await requestOverSocket(socketPath, "GET", "/operator-info");
    expect(getRes.body).toEqual({ operatorInfo: info });
  });

  it("POST /operator-info with no body is a usage error", async () => {
    const { socketPath } = await boot();
    const res = await requestOverSocket(socketPath, "POST", "/operator-info");
    expect(res.status).toBe(400);
  });
});

describe("admin socket: /plugins/trust-builtins ids filter (T5.3)", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];
  const stores: StateStore[] = [];

  afterEach(async () => {
    servers.splice(0).forEach((s) => s.close());
    stores.splice(0).forEach((s) => s.close());
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  async function bootWithBuiltins(builtinIds: string[]) {
    const heartbeat: HeartbeatState = { current: { phase: "pending-init", ts: "x", version: "0.1.0" } };
    const dbDir = await mkdtemp(join(tmpdir(), "wanfw-admin-state-"));
    dirs.push(dbDir);
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const keyDir = await mkdtemp(join(tmpdir(), "wanfw-admin-key-"));
    dirs.push(keyDir);
    const signingKeyHolder = { manager: await SigningKeyManager.loadOrCreate(join(keyDir, "signing.key")), keyPath: join(keyDir, "signing.key") };
    const auditDir = await mkdtemp(join(tmpdir(), "wanfw-admin-audit-"));
    dirs.push(auditDir);
    const auditLog = new AuditLog(join(auditDir, "audit.jsonl"), () => signingKeyHolder.manager);
    const stagingDir = await mkdtemp(join(tmpdir(), "wanfw-admin-staging-"));
    dirs.push(stagingDir);
    const bundlesDir = await mkdtemp(join(tmpdir(), "wanfw-admin-bundles-"));
    dirs.push(bundlesDir);
    const statusDir = await mkdtemp(join(tmpdir(), "wanfw-admin-status-"));
    dirs.push(statusDir);
    const secretsDir = await mkdtemp(join(tmpdir(), "wanfw-admin-secrets-"));
    dirs.push(secretsDir);
    const certsDir = await mkdtemp(join(tmpdir(), "wanfw-admin-certs-"));
    dirs.push(certsDir);
    const socketDir = await mkdtemp(join(tmpdir(), "wanfw-admin-sock-"));
    dirs.push(socketDir);

    const connection = {
      call: async (method: string, params?: unknown) => {
        if (method === "builtins.list") {
          return builtinIds.map((id) => ({ id, version: "0.1.0", manifest: { id, version: "0.1.0", types: [], capabilities: [] }, sha256: `${id}-sha` }));
        }
        if (method === "builtins.read") {
          return { files: [{ relPath: "manifest.json", contentBase64: Buffer.from(JSON.stringify({ id: (params as { id: string }).id, version: "0.1.0", manifestVersion: 1, frameworkApi: "^1.0.0", types: [], entrypoint: "main.js", runtime: "node22", capabilities: [] })).toString("base64") }] };
        }
        if (method === "helper.wanIp") {
          return { ip: "203.0.113.5" };
        }
        throw new Error(`unexpected call: ${method}`);
      },
    };

    const router = buildAdminSocketRouter({
      heartbeat,
      signingKeyHolder,
      store,
      auditLog,
      pluginConnectionHolder: { connection: connection as never },
      stagingDir,
      bundlesDir,
      statusDir,
      secretsDir,
      certsDir,
      gateSnapshotHolder: { services: new Map() },
    });
    const socketPath = join(socketDir, "admin.sock");
    const server = listenOnUnixSocket(router, socketPath, 0o600);
    servers.push(server);
    await new Promise((r) => setTimeout(r, 50));
    return { socketPath, store };
  }

  it("with no ids filter, trusts every builtin the image ships (pre-T5.3 behavior, still used by --builtin-all)", async () => {
    const { socketPath, store } = await bootWithBuiltins(["deploy-docker", "dns-mock"]);
    const res = await requestOverSocket(socketPath, "POST", "/plugins/trust-builtins");
    expect(res.status).toBe(200);
    expect(store.listTrustRecords().map((r) => r.plugin_id).sort()).toEqual(["deploy-docker", "dns-mock"]);
  });

  it("with an ids filter, trusts only the named builtins -- dns-mock is never trusted when omitted from the list", async () => {
    const { socketPath, store } = await bootWithBuiltins(["deploy-docker", "network-bridge", "dns-mock"]);
    const res = await requestOverSocket(socketPath, "POST", "/plugins/trust-builtins", { ids: ["deploy-docker", "network-bridge"] });
    expect(res.status).toBe(200);
    expect(store.listTrustRecords().map((r) => r.plugin_id).sort()).toEqual(["deploy-docker", "network-bridge"]);
  });

  it("GET /network/wan-ip returns the detected WAN IP via helper.wanIp", async () => {
    const { socketPath } = await bootWithBuiltins([]);
    const res = await requestOverSocket(socketPath, "GET", "/network/wan-ip");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ip: "203.0.113.5" });
  });

  it("GET /doctor runs the doctor checks, including a real WAN-IP/DNS check via helper.wanIp/helper.resolveA", async () => {
    const { socketPath, store } = await bootWithBuiltins([]);
    store.setFrameworkDoc({ spec: { domain: "example.tld", roles: { networkProvider: "network-bridge" } } });
    const res = await requestOverSocket(socketPath, "GET", "/doctor");
    expect(res.status).toBe(200);
    const checks = (res.body as { checks: Array<{ name: string; status: string }> }).checks;
    expect(checks.find((c) => c.name === "wan-ip-detect")?.status).toBe("pass");
    expect(checks.find((c) => c.name === "framework-doc")?.status).toBe("pass");
  });

  it("POST /network/probe-macvlan forwards to the injected probeNetwork and returns its real result -- the wizard's pre-flight check (T5.3)", async () => {
    const heartbeat: HeartbeatState = { current: { phase: "pending-init", ts: "x", version: "0.1.0" } };
    const dbDir = await mkdtemp(join(tmpdir(), "wanfw-admin-probe-"));
    dirs.push(dbDir);
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const keyDir = await mkdtemp(join(tmpdir(), "wanfw-admin-probe-key-"));
    dirs.push(keyDir);
    const signingKeyHolder = { manager: await SigningKeyManager.loadOrCreate(join(keyDir, "signing.key")), keyPath: join(keyDir, "signing.key") };
    const auditDir = await mkdtemp(join(tmpdir(), "wanfw-admin-probe-audit-"));
    dirs.push(auditDir);
    const auditLog = new AuditLog(join(auditDir, "audit.jsonl"), () => signingKeyHolder.manager);
    const stagingDir = await mkdtemp(join(tmpdir(), "wanfw-admin-probe-staging-"));
    dirs.push(stagingDir);
    const socketDir = await mkdtemp(join(tmpdir(), "wanfw-admin-probe-sock-"));
    dirs.push(socketDir);

    let calledWith: string | undefined;
    const router = buildAdminSocketRouter({
      heartbeat,
      signingKeyHolder,
      store,
      auditLog,
      pluginConnectionHolder: {},
      stagingDir,
      bundlesDir: stagingDir,
      statusDir: stagingDir,
      secretsDir: stagingDir,
      certsDir: stagingDir,
      gateSnapshotHolder: { services: new Map() },
      probeNetwork: async (mode, parent) => {
        calledWith = parent;
        return mode === "macvlan" && parent === "eth0.50" ? { ok: true } : { ok: false, reason: "no promiscuous mode" };
      },
    });
    const socketPath = join(socketDir, "admin.sock");
    servers.push(listenOnUnixSocket(router, socketPath, 0o600));
    await new Promise((r) => setTimeout(r, 50));

    const passRes = await requestOverSocket(socketPath, "POST", "/network/probe-macvlan", { parent: "eth0.50" });
    expect(passRes.status).toBe(200);
    expect(passRes.body).toEqual({ ok: true });
    expect(calledWith).toBe("eth0.50");

    const failRes = await requestOverSocket(socketPath, "POST", "/network/probe-macvlan", { parent: "eth0" });
    expect(failRes.body).toEqual({ ok: false, reason: "no promiscuous mode" });

    const usageRes = await requestOverSocket(socketPath, "POST", "/network/probe-macvlan", {});
    expect(usageRes.status).toBe(400);
  });
});
