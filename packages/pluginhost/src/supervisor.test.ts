import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { JsonRpcConnection } from "./jsonrpc.js";
import { registerSupervisorMethods } from "./supervisor.js";

function makePair(): [JsonRpcConnection, JsonRpcConnection] {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new JsonRpcConnection(bToA, aToB);
  const b = new JsonRpcConnection(aToB, bToA);
  return [a, b];
}

describe("registerSupervisorMethods", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeBuiltinsDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-builtins-"));
    dirs.push(dir);
    await mkdir(join(dir, "deploy-docker"), { recursive: true });
    await writeFile(
      join(dir, "deploy-docker", "manifest.json"),
      JSON.stringify({ manifestVersion: 1, id: "deploy-docker", version: "0.1.0" }),
    );
    return dir;
  }

  it("builtins.list returns every built-in with id/version/manifest/sha256", async () => {
    const builtinsDir = await makeBuiltinsDir();
    const [orchestrator, pluginhost] = makePair();
    registerSupervisorMethods(pluginhost, {
      builtinsDir,
      hashBundleDirFn: async () => "fakehash123",
      hostApiHandler: async () => ({}),
    });

    const result = (await orchestrator.call("builtins.list")) as Array<{ id: string; sha256: string }>;
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("deploy-docker");
    expect(result[0]!.sha256).toBe("fakehash123");
  });

  it("builtins.read returns the bundle location and hash for one built-in", async () => {
    const builtinsDir = await makeBuiltinsDir();
    const [orchestrator, pluginhost] = makePair();
    registerSupervisorMethods(pluginhost, {
      builtinsDir,
      hashBundleDirFn: async () => "fakehash456",
      hostApiHandler: async () => ({}),
    });

    const result = (await orchestrator.call("builtins.read", { id: "deploy-docker" })) as { sha256: string };
    expect(result.sha256).toBe("fakehash456");
  });

  it("builtins.read streams real file bytes the orchestrator can reconstruct on disk", async () => {
    const builtinsDir = await makeBuiltinsDir();
    const [orchestrator, pluginhost] = makePair();
    registerSupervisorMethods(pluginhost, {
      builtinsDir,
      hashBundleDirFn: async () => "fakehash789",
      hostApiHandler: async () => ({}),
    });

    const result = (await orchestrator.call("builtins.read", { id: "deploy-docker" })) as {
      files: Array<{ relPath: string; contentBase64: string }>;
    };
    const manifestFile = result.files.find((f) => f.relPath === "manifest.json");
    expect(manifestFile).toBeDefined();
    const decoded = JSON.parse(Buffer.from(manifestFile!.contentBase64, "base64").toString("utf8"));
    expect(decoded).toEqual({ manifestVersion: 1, id: "deploy-docker", version: "0.1.0" });
  });

  it("invoke dispatches to the child runner and returns its result", async () => {
    const echoBundleDir = await mkdtemp(join(tmpdir(), "wanfw-invoke-fixture-"));
    dirs.push(echoBundleDir);
    await mkdir(join(echoBundleDir, "dist"), { recursive: true });
    await writeFile(join(echoBundleDir, "manifest.json"), '{"id":"echo"}');
    await writeFile(
      join(echoBundleDir, "dist", "main.js"),
      [
        "process.stdin.setEncoding('utf8');",
        "let buf='';",
        "process.stdin.on('data', c => {",
        "  buf += c;",
        "  let i;",
        "  while ((i = buf.indexOf('\\n')) !== -1) {",
        "    const line = buf.slice(0, i); buf = buf.slice(i+1);",
        "    if (!line.trim()) continue;",
        "    const msg = JSON.parse(line);",
        "    if (msg.method && msg.id) process.stdout.write(JSON.stringify({jsonrpc:'2.0', id: msg.id, result: msg.params}) + '\\n');",
        "  }",
        "});",
      ].join("\n"),
    );

    const { hashBundleDir } = await import("@wanfw/core-schemas");
    const bundleHash = await hashBundleDir(echoBundleDir);

    const [orchestrator, pluginhost] = makePair();
    let forwardedParams: unknown;
    registerSupervisorMethods(pluginhost, {
      builtinsDir: echoBundleDir,
      hashBundleDirFn: hashBundleDir,
      hostApiHandler: async (params) => {
        forwardedParams = params;
        return { ok: true };
      },
    });

    const result = (await orchestrator.call("invoke", {
      invocationId: "inv-x",
      pluginId: "echo",
      bundleHash,
      bundleDir: echoBundleDir,
      task: "echo",
      input: { hello: "world" },
      limits: { wallMs: 3000, memMb: 1536, cpuSeconds: 5 },
    })) as { ok: boolean; result: unknown };

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ hello: "world" });
    void forwardedParams; // host API not exercised by this fixture; wiring covered elsewhere
  });
});
