import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SigningKeyManager } from "./signing-key.js";
import { StateStore } from "./state-store/store.js";

describe("SigningKeyManager", () => {
  const dirs: string[] = [];

  afterEach(() => {
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function tempKeyPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "wanfw-key-"));
    dirs.push(dir);
    return join(dir, "signing.key");
  }

  it("generates a key at first boot with 0600 permissions", async () => {
    const keyPath = tempKeyPath();
    expect(existsSync(keyPath)).toBe(false);
    await SigningKeyManager.loadOrCreate(keyPath);
    expect(existsSync(keyPath)).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("loads the same key on a second boot (persists identity)", async () => {
    const keyPath = tempKeyPath();
    const first = await SigningKeyManager.loadOrCreate(keyPath);
    const second = await SigningKeyManager.loadOrCreate(keyPath);
    expect(first.getPublicKeyPem()).toBe(second.getPublicKeyPem());
  });

  it("sign/verify round-trips", async () => {
    const keyPath = tempKeyPath();
    const mgr = await SigningKeyManager.loadOrCreate(keyPath);
    const sig = mgr.sign("hello world");
    expect(mgr.verify("hello world", sig)).toBe(true);
  });

  it("verify fails for tampered payload", async () => {
    const keyPath = tempKeyPath();
    const mgr = await SigningKeyManager.loadOrCreate(keyPath);
    const sig = mgr.sign("hello world");
    expect(mgr.verify("goodbye world", sig)).toBe(false);
  });

  it("verify fails for a garbage signature (never throws)", async () => {
    const keyPath = tempKeyPath();
    const mgr = await SigningKeyManager.loadOrCreate(keyPath);
    expect(mgr.verify("hello world", "not-base64-!!!")).toBe(false);
  });

  it("rotate: changes the public key, and old signatures no longer verify against it", async () => {
    const keyPath = tempKeyPath();
    const mgr = await SigningKeyManager.loadOrCreate(keyPath);
    const oldPub = mgr.getPublicKeyPem();
    const sig = mgr.sign("some record content");

    await mgr.rotate();

    expect(mgr.getPublicKeyPem()).not.toBe(oldPub);
    // Old signature verified against the OLD public key still checks out...
    expect(mgr.verify("some record content", sig, oldPub)).toBe(true);
    // ...but verified against the CURRENT (new) key, it's stale.
    expect(mgr.verify("some record content", sig)).toBe(false);
  });

  it("rotate persists the new key across a reload", async () => {
    const keyPath = tempKeyPath();
    const mgr = await SigningKeyManager.loadOrCreate(keyPath);
    await mgr.rotate();
    const rotatedPub = mgr.getPublicKeyPem();

    const reloaded = await SigningKeyManager.loadOrCreate(keyPath);
    expect(reloaded.getPublicKeyPem()).toBe(rotatedPub);
  });

  it("importFrom replaces custody with an operator-supplied key", async () => {
    const keyPathA = tempKeyPath();
    const keyPathB = tempKeyPath();
    const mgrA = await SigningKeyManager.loadOrCreate(keyPathA);
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

    const imported = await SigningKeyManager.importFrom(keyPathB, pem);
    expect(imported.getPublicKeyPem()).not.toBe(mgrA.getPublicKeyPem());

    const reloaded = await SigningKeyManager.loadOrCreate(keyPathB);
    expect(reloaded.getPublicKeyPem()).toBe(imported.getPublicKeyPem());
  });

  it("reSignAll re-signs all live trust/grant/approval records so they verify under the new key", async () => {
    const keyPath = tempKeyPath();
    const dbDir = mkdtempSync(join(tmpdir(), "wanfw-key-db-"));
    dirs.push(dbDir);
    const store = new StateStore(join(dbDir, "state.sqlite3"));

    const mgr = await SigningKeyManager.loadOrCreate(keyPath);

    const { canonicalTrustRecordPayload, canonicalGrantPayload, canonicalApprovalPayload } = await import(
      "./signing-key.js"
    );

    store.insertTrustRecord({
      plugin_id: "deploy-docker",
      version: "0.1.0",
      sha256: "abc",
      granted_caps_json: "[]",
      sig: mgr.sign(canonicalTrustRecordPayload("deploy-docker", "0.1.0", "abc", "[]")),
      created_at: new Date().toISOString(),
    });
    store.insertGrant({
      plugin_id: "deploy-docker",
      cap: "docker.device",
      scope_json: '{"paths":["/dev/dri/*"]}',
      sig: mgr.sign(canonicalGrantPayload("deploy-docker", "docker.device", '{"paths":["/dev/dri/*"]}')),
      created_at: new Date().toISOString(),
    });
    store.insertApproval({
      projection_hash: "hash1",
      service_id: "jellyfin",
      human_rendering: "x",
      sig: mgr.sign(canonicalApprovalPayload("hash1", "jellyfin", "x")),
      approved_at: new Date().toISOString(),
    });

    await mgr.rotate();
    mgr.reSignAll(store);

    const trust = store.getTrustRecord("deploy-docker", "0.1.0")!;
    expect(mgr.verify(canonicalTrustRecordPayload("deploy-docker", "0.1.0", "abc", "[]"), trust.sig)).toBe(true);

    const grants = store.listGrants("deploy-docker");
    expect(mgr.verify(canonicalGrantPayload("deploy-docker", "docker.device", '{"paths":["/dev/dri/*"]}'), grants[0]!.sig)).toBe(
      true,
    );

    const approval = store.getApproval("hash1")!;
    expect(mgr.verify(canonicalApprovalPayload("hash1", "jellyfin", "x"), approval.sig)).toBe(true);

    store.close();
  });
});
