import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { StateStore } from "./state-store/store.js";
import { SigningKeyManager, canonicalApprovalPayload } from "./signing-key.js";
import { AuditLog } from "./audit-log.js";
import { trustStagedBundle, TrustFlowError, type TrustFlowDeps } from "./trust/index.js";
import { buildGateStage, type GateSnapshotHolder } from "./reconciler/gate-stage.js";
import { buildExecuteStage } from "./reconciler/execute-stage.js";
import { FakeDockerClient } from "./execute/fake-docker-client.js";
import type { DesiredState, LoadedDocument } from "./desired-state/index.js";
import type { PlanGraph } from "./reconciler/plan-stage.js";
import type { ReconcileRunContext } from "./reconciler/types.js";

/**
 * T6.6: one suite exercising the spec §1.2 negative acceptance list end to
 * end, plus the M5-specific extras the plan's own Build line names (key
 * rotate/import, `audit tail --verify` over the full run history). Each
 * item already has a dedicated, more granular test elsewhere in the suite
 * (trust-flow.test.ts, gate-stage.test.ts, signing-key.test.ts,
 * audit-log.test.ts, test/integration/run.sh's compose-level assertion) --
 * this file exists specifically to prove the *combination* the spec's own
 * scenario describes, not to duplicate coverage that already exists.
 */
describe("§1.2 negative acceptance (T6.6)", () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((s) => s.close());
    dirs.splice(0).forEach((d) => rm(d, { recursive: true, force: true }).catch(() => {}));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wanfw-negaccept-"));
    dirs.push(dir);
    return dir;
  }

  function frameworkDoc(): LoadedDocument {
    return {
      kind: "Framework",
      id: "framework",
      spec: { domain: "example.tld", deploymentMode: "subdomain", acmeEmail: "ops@example.tld", roles: {} },
      schemaVersion: 1,
      sourcePath: "framework.json",
    };
  }

  it("1. a tampered plugin bundle (hash mismatch vs the trust store) is refused at load, loudly -- never silently substituted or partially trusted", async () => {
    const stagingDir = await tempDir();
    const bundlesDir = await tempDir();
    const dbDir = await tempDir();
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const signingKey = await SigningKeyManager.loadOrCreate(join(dbDir, "signing.key"));
    const auditLog = new AuditLog(join(dbDir, "audit.jsonl"), () => signingKey);
    const deps: TrustFlowDeps = { store, signingKey, auditLog, stagingDir, bundlesDir };

    const bundleDir = join(stagingDir, "evil-plugin");
    await mkdir(join(bundleDir, "dist"), { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "deploy-docker",
        version: "0.1.0",
        frameworkApi: "^1.0",
        types: ["deploy"],
        entrypoint: "dist/main.js",
        runtime: "node22",
        capabilities: [],
      }),
    );
    await writeFile(join(bundleDir, "dist", "main.js"), "// fixture\n");

    // The hash claimed here does not match what's actually staged -- exactly
    // the "tampered bundle" scenario (content changed after staging, or an
    // attacker trying to get a different hash trusted under a familiar id).
    const claimedHash = "0".repeat(64);
    await expect(trustStagedBundle(deps, "deploy-docker", claimedHash)).rejects.toThrow(TrustFlowError);
    expect(store.listTrustRecords()).toHaveLength(0); // nothing was trusted, not even partially
  });

  it("2/4. a powerful plan (docker.sock bind mount) does not execute without an approval record; status surfaces it as pending with the root-equivalence banner; approving it lets it execute", async () => {
    const store = await (async () => {
      const dbDir = await tempDir();
      const s = new StateStore(join(dbDir, "state.sqlite3"));
      stores.push(s);
      return s;
    })();

    const desiredState: DesiredState = { framework: frameworkDoc(), services: new Map(), pluginConfigs: new Map(), errors: [] };
    const planGraph: PlanGraph = {
      servicePlans: {
        evil: {
          image: "evil/evil:latest",
          mounts: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock", readOnly: false }],
        },
      },
      routes: [],
      certRequirements: { mode: "internal-ca", names: [] },
    };
    const validation = { evil: { tier: "powerful" as const } };

    const holder: GateSnapshotHolder = { services: new Map() };
    const gateStage = buildGateStage({ store }, holder);
    const docker = new FakeDockerClient();
    const proxycfgDir = await tempDir();
    const executeStage = buildExecuteStage({ store, docker, proxycfgDir, certsVolumeName: "wanfw_certs", proxycfgVolumeName: "wanfw_proxycfg" });

    // -- Negative acceptance item 2: no approval yet -----------------------
    await gateStage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);
    const pending = holder.services.get("evil")!;
    expect(pending.approved).toBe(false); // "status surfaces it as pending"
    expect(pending.banners[0]).toContain("This grant is equivalent to root on the host"); // -- negative acceptance item 4

    const execResultBeforeApproval = await executeStage.run({
      desiredState,
      planGraph,
      gateSnapshot: holder.services,
    } as unknown as ReconcileRunContext);
    expect(execResultBeforeApproval.ok).toBe(true); // not executing an unapproved powerful plan is not a stage failure
    expect(docker.containers.has("wanfw_evil")).toBe(false); // it categorically did not execute

    // -- Approve it, exactly the way `wanfwctl plan approve` does ----------
    const signingKey = await SigningKeyManager.loadOrCreate(join(await tempDir(), "signing.key"));
    const payload = canonicalApprovalPayload(pending.projectionHash, pending.serviceId, pending.humanRendering);
    store.insertApproval({
      projection_hash: pending.projectionHash,
      service_id: pending.serviceId,
      human_rendering: pending.humanRendering,
      sig: signingKey.sign(payload),
      approved_at: new Date().toISOString(),
    });

    await gateStage.run({ desiredState, planGraph, validation } as unknown as ReconcileRunContext);
    expect(holder.services.get("evil")?.approved).toBe(true);

    const execResultAfterApproval = await executeStage.run({
      desiredState,
      planGraph,
      gateSnapshot: holder.services,
    } as unknown as ReconcileRunContext);
    expect(execResultAfterApproval.ok).toBe(true);
    expect(docker.containers.has("wanfw_evil")).toBe(true); // *only now* does it execute
  });

  it("3. tier1's compose service definition mounts no Docker socket of any kind (compose-level half of the assertion; the live integration-test half runs in test/integration/run.sh)", async () => {
    const { readFile } = await import("node:fs/promises");
    const composeYaml = await readFile(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
    const tier1Block = composeYaml.slice(composeYaml.indexOf("  tier1:"), composeYaml.indexOf("  orchestrator:"));
    expect(tier1Block).not.toContain("docker.sock");
  });

  it("key rotate re-signs live records under the new key; key import replaces custody outright", async () => {
    const dbDir = await tempDir();
    const store = new StateStore(join(dbDir, "state.sqlite3"));
    stores.push(store);
    const signingKey = await SigningKeyManager.loadOrCreate(join(dbDir, "signing.key"));
    store.insertApproval({
      projection_hash: "hash1",
      service_id: "svc",
      human_rendering: "x",
      sig: signingKey.sign(canonicalApprovalPayload("hash1", "svc", "x")),
      approved_at: new Date().toISOString(),
    });

    const oldPublicKey = signingKey.getPublicKeyPem();
    await signingKey.rotate();
    signingKey.reSignAll(store);
    expect(signingKey.getPublicKeyPem()).not.toBe(oldPublicKey);

    // Everything signed under the old key still verifies under the new one
    // (re-signed in place), proving rotate doesn't silently invalidate history.
    const approvals = store.listApprovals();
    expect(approvals).toHaveLength(1);
    const payload = canonicalApprovalPayload(approvals[0]!.projection_hash, approvals[0]!.service_id, approvals[0]!.human_rendering);
    expect(signingKey.verify(payload, approvals[0]!.sig)).toBe(true);

    // key import: an operator-supplied PKCS8 PEM replaces custody outright.
    const { privateKey } = generateKeyPairSync("ed25519");
    const importedPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const reimported = await SigningKeyManager.importFrom(join(dbDir, "signing.key"), importedPem);
    expect(reimported.getPublicKeyPem()).not.toBe(signingKey.getPublicKeyPem()); // genuinely different custody, not a no-op
  });

  it("audit tail --verify stays green over a full run's history: trust + approve + rotate + revoke, chained", async () => {
    const dbDir = await tempDir();
    const signingKey = await SigningKeyManager.loadOrCreate(join(dbDir, "signing.key"));
    const auditLog = new AuditLog(join(dbDir, "audit.jsonl"), () => signingKey);

    auditLog.append({ type: "plugin.trust", details: { id: "deploy-docker" } });
    auditLog.append({ type: "plan.approve", details: { serviceId: "jellyfin" } });
    auditLog.append({ type: "key.rotate", details: {} });
    auditLog.append({ type: "plan.revoke", details: { projectionHash: "abc" } });

    const result = auditLog.verify();
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(4);
  });
});
