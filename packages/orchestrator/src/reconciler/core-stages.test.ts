import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state-store/store.js";
import { buildLoadStage, buildResolveStage } from "./core-stages.js";
import type { ReconcileRunContext } from "./types.js";

describe("core reconciler stages", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rm(d, { recursive: true, force: true }).catch(() => {}));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-recstage-"));
    dirs.push(dir);
    return dir;
  }

  it("load stage succeeds on an empty desired-state dir and populates ctx.desiredState", async () => {
    const desiredDir = await tempDir();
    await mkdir(join(desiredDir, "services"), { recursive: true });
    const stage = buildLoadStage({ desiredDir, bundlesDir: "", store: null as unknown as StateStore });
    const ctx: ReconcileRunContext = {};
    const result = await stage.run(ctx);
    expect(result.ok).toBe(true);
    expect(ctx.desiredState).toBeDefined();
  });

  it("load stage updates the roles holder with the framework doc's current role bindings, read live by T4.3's DNS broker", async () => {
    const desiredDir = await tempDir();
    await mkdir(join(desiredDir, "services"), { recursive: true });
    await writeFile(
      join(desiredDir, "framework.json"),
      JSON.stringify({
        kind: "Framework",
        schemaVersion: 1,
        metadata: { id: "framework" },
        spec: {
          domain: "example.tld",
          deploymentMode: "subdomain",
          acmeEmail: "ops@example.tld",
          roles: { networkProvider: "network-bridge", proxyEngine: "proxy-caddy", dnsProvider: "dns-namecheap" },
        },
      }),
    );
    const rolesHolder = { roles: {} };
    const stage = buildLoadStage({ desiredDir, bundlesDir: "", store: null as unknown as StateStore, rolesHolder });
    await stage.run({});
    expect(rolesHolder.roles).toEqual({ networkProvider: "network-bridge", proxyEngine: "proxy-caddy", dnsProvider: "dns-namecheap" });
  });

  it("load stage clears the roles holder back to {} when the framework doc disappears", async () => {
    const desiredDir = await tempDir();
    await mkdir(join(desiredDir, "services"), { recursive: true });
    const rolesHolder = { roles: { dnsProvider: "dns-namecheap" } };
    const stage = buildLoadStage({ desiredDir, bundlesDir: "", store: null as unknown as StateStore, rolesHolder });
    await stage.run({});
    expect(rolesHolder.roles).toEqual({});
  });

  it("load stage syncs the ipam macvlan range from framework.spec.network.macvlan on every load (T5.1)", async () => {
    const desiredDir = await tempDir();
    await mkdir(join(desiredDir, "services"), { recursive: true });
    await writeFile(
      join(desiredDir, "framework.json"),
      JSON.stringify({
        kind: "Framework",
        schemaVersion: 1,
        metadata: { id: "framework" },
        spec: {
          domain: "example.tld",
          deploymentMode: "subdomain",
          acmeEmail: "ops@example.tld",
          roles: { networkProvider: "network-macvlan", proxyEngine: "proxy-caddy" },
          network: { lanInterface: "eth0", macvlan: { parent: "eth0", reservedCidr: "192.168.1.240/29", gateway: "192.168.1.241" } },
        },
      }),
    );
    const dbDir = await tempDir();
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const stage = buildLoadStage({ desiredDir, bundlesDir: "", store });
    await stage.run({});
    expect(store.getIpamRange("macvlan")).toEqual({ id: "macvlan", cidr: "192.168.1.240/29", gateway: "192.168.1.241" });
  });

  it("load stage leaves the ipam macvlan range untouched when no framework.spec.network.macvlan is configured", async () => {
    const desiredDir = await tempDir();
    await mkdir(join(desiredDir, "services"), { recursive: true });
    const dbDir = await tempDir();
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const stage = buildLoadStage({ desiredDir, bundlesDir: "", store });
    await stage.run({});
    expect(store.getIpamRange("macvlan")).toBeUndefined();
  });

  it("load stage fails with a structured error when a document is invalid", async () => {
    const desiredDir = await tempDir();
    await mkdir(join(desiredDir, "services"), { recursive: true });
    await writeFile(join(desiredDir, "services", "bad.json"), JSON.stringify({ kind: "Service" }));
    const stage = buildLoadStage({ desiredDir, bundlesDir: "", store: null as unknown as StateStore });
    const result = await stage.run({});
    expect(result.ok).toBe(false);
    expect(result.error?.stage).toBe("load");
  });

  it("resolve stage passes through when there is no framework document yet", async () => {
    const dbDir = await tempDir();
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const stage = buildResolveStage({ desiredDir: "", bundlesDir: await tempDir(), store });
    const result = await stage.run({ desiredState: { services: new Map(), pluginConfigs: new Map(), errors: [] } });
    expect(result.ok).toBe(true);
  });

  it("resolve stage fails with a structured, plugin-attributed error when dependencies don't resolve", async () => {
    const dbDir = await tempDir();
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const bundlesDir = await tempDir();

    const stage = buildResolveStage({ desiredDir: "", bundlesDir, store });
    const ctx: ReconcileRunContext = {
      desiredState: {
        services: new Map(),
        pluginConfigs: new Map(),
        errors: [],
        framework: {
          kind: "Framework",
          id: "framework",
          spec: { deploymentMode: "subdomain", roles: { networkProvider: "never-trusted" } },
          schemaVersion: 1,
          sourcePath: "framework.json",
        },
      },
    };
    const result = await stage.run(ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.stage).toBe("resolve");
    expect(result.error?.plugin).toBe("never-trusted");
  });
});
