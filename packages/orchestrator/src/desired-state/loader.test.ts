import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDesiredState } from "./loader.js";
import { CURRENT_SCHEMA_VERSION } from "./migrations.js";

describe("loadDesiredState", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDesiredDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-desired-"));
    dirs.push(dir);
    await mkdir(join(dir, "services"), { recursive: true });
    await mkdir(join(dir, "plugins"), { recursive: true });
    return dir;
  }

  it("tolerates a completely empty desired-state dir (pre-init state)", async () => {
    const dir = await tempDesiredDir();
    const state = await loadDesiredState(dir);
    expect(state.framework).toBeUndefined();
    expect(state.services.size).toBe(0);
    expect(state.errors).toEqual([]);
  });

  it("loads a valid framework document, passed in already-parsed (T5.3: it lives in wanfw_state, not a file)", async () => {
    const dir = await tempDesiredDir();
    const frameworkRaw = {
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
    const state = await loadDesiredState(dir, frameworkRaw);
    expect(state.framework?.id).toBe("framework");
    expect(state.errors).toEqual([]);
  });

  it("surfaces an invalid framework document as a structured error, same as a file-loaded document would", async () => {
    const dir = await tempDesiredDir();
    const state = await loadDesiredState(dir, { kind: "Framework" }); // missing schemaVersion/metadata/spec
    expect(state.framework).toBeUndefined();
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]?.message).toContain("envelope invalid");
  });

  it("loads multiple valid service documents", async () => {
    const dir = await tempDesiredDir();
    await writeFile(
      join(dir, "services", "jellyfin.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "Service",
        metadata: { id: "jellyfin", displayName: "Jellyfin" },
        spec: {
          deploy: { plugin: "deploy-docker", image: "jellyfin/jellyfin:10.9.11" },
          expose: { hostname: "jellyfin", backendPort: 8096, backendProtocol: "http" },
        },
      }),
    );
    await writeFile(
      join(dir, "services", "kavita.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "Service",
        metadata: { id: "kavita" },
        spec: {
          deploy: { plugin: "deploy-docker" },
          expose: { hostname: "kavita", backendPort: 5000, backendProtocol: "http" },
        },
      }),
    );
    const state = await loadDesiredState(dir);
    expect(state.services.size).toBe(2);
    expect(state.services.get("jellyfin")?.displayName).toBe("Jellyfin");
    expect(state.errors).toEqual([]);
  });

  it("collects an envelope-invalid document as a per-document error, not a fatal load failure", async () => {
    const dir = await tempDesiredDir();
    await writeFile(join(dir, "services", "bad.json"), JSON.stringify({ kind: "Service" })); // missing required fields
    await writeFile(
      join(dir, "services", "good.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "Service",
        metadata: { id: "good" },
        spec: {
          deploy: { plugin: "deploy-docker" },
          expose: { hostname: "good", backendPort: 80, backendProtocol: "http" },
        },
      }),
    );
    const state = await loadDesiredState(dir);
    expect(state.services.size).toBe(1);
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]?.sourcePath).toMatch(/bad\.json/);
  });

  it("collects a spec-invalid document (fails the Service anchor schema) as a per-document error", async () => {
    const dir = await tempDesiredDir();
    await writeFile(
      join(dir, "services", "bad-spec.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "Service",
        metadata: { id: "bad-spec" },
        spec: { deploy: { plugin: "deploy-docker" } }, // missing required "expose"
      }),
    );
    const state = await loadDesiredState(dir);
    expect(state.services.size).toBe(0);
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]?.message).toMatch(/spec invalid/);
  });

  it("refuses a document newer than CURRENT_SCHEMA_VERSION with a clear status error, per-document", async () => {
    const dir = await tempDesiredDir();
    await writeFile(
      join(dir, "services", "future.json"),
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION + 5,
        kind: "Service",
        metadata: { id: "future" },
        spec: {
          deploy: { plugin: "deploy-docker" },
          expose: { hostname: "future", backendPort: 80, backendProtocol: "http" },
        },
      }),
    );
    const state = await loadDesiredState(dir);
    expect(state.services.size).toBe(0);
    expect(state.errors[0]?.message).toMatch(/upgrade the framework/i);
  });

  it("loads plugin config documents from the plugins subdirectory", async () => {
    const dir = await tempDesiredDir();
    await writeFile(
      join(dir, "plugins", "dns-namecheap.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "PluginConfig",
        metadata: { id: "dns-namecheap" },
        spec: { pluginId: "dns-namecheap", config: {} },
      }),
    );
    const state = await loadDesiredState(dir);
    expect(state.pluginConfigs.size).toBe(1);
  });
});
