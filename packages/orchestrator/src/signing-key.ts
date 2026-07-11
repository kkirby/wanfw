import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, chmodSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "@wanfw/core-schemas";
import type { StateStore } from "./state-store/store.js";

/**
 * Ed25519 signing key custody (ADR-5). The key signs trust records, grant
 * records, approval records, and audit checkpoints. Generated at first boot
 * into wanfw_state (0600). No passphrase wrapping in v1 -- the key's
 * confidentiality boundary is the orchestrator volume (ADR-5 rationale).
 */
export class SigningKeyManager {
  private keyPath: string;
  private privateKey: KeyObject;
  private publicKey: KeyObject;

  private constructor(keyPath: string, privateKey: KeyObject, publicKey: KeyObject) {
    this.keyPath = keyPath;
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  static async loadOrCreate(keyPath: string): Promise<SigningKeyManager> {
    if (existsSync(keyPath)) {
      const pem = readFileSync(keyPath, "utf8");
      const privateKey = { key: pem, format: "pem" as const, type: "pkcs8" as const };
      const { createPrivateKey, createPublicKey } = await import("node:crypto");
      const priv = createPrivateKey(privateKey);
      const pub = createPublicKey(priv);
      return new SigningKeyManager(keyPath, priv, pub);
    }

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    await atomicWriteFile(keyPath, pem, { mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // best-effort; some dev/test filesystems reject chmod
    }
    return new SigningKeyManager(keyPath, privateKey, publicKey);
  }

  /** Replaces custody with an operator-supplied PKCS8 PEM (`wanfwctl key import`). */
  static async importFrom(keyPath: string, pkcs8Pem: string): Promise<SigningKeyManager> {
    const { createPrivateKey, createPublicKey } = await import("node:crypto");
    const priv = createPrivateKey({ key: pkcs8Pem, format: "pem", type: "pkcs8" });
    const pub = createPublicKey(priv);
    await atomicWriteFile(keyPath, pkcs8Pem, { mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // best-effort
    }
    return new SigningKeyManager(keyPath, priv, pub);
  }

  /** Generates a brand-new key and takes over custody at the same path. */
  async rotate(): Promise<void> {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    await atomicWriteFile(this.keyPath, pem, { mode: 0o600 });
    try {
      chmodSync(this.keyPath, 0o600);
    } catch {
      // best-effort
    }
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  /** Re-signs every live trust/grant/approval record with the current key. */
  reSignAll(store: StateStore): void {
    for (const record of store.listTrustRecords()) {
      const payload = canonicalTrustRecordPayload(record.plugin_id, record.version, record.sha256, record.granted_caps_json);
      const sig = this.sign(payload);
      store.db
        .prepare("UPDATE trust_records SET sig = ? WHERE plugin_id = ? AND version = ?")
        .run(sig, record.plugin_id, record.version);
    }
    for (const grant of allGrants(store)) {
      const payload = canonicalGrantPayload(grant.plugin_id, grant.cap, grant.scope_json);
      const sig = this.sign(payload);
      store.db.prepare("UPDATE grants SET sig = ? WHERE id = ?").run(sig, grant.id);
    }
    for (const approval of store.listApprovals()) {
      const payload = canonicalApprovalPayload(approval.projection_hash, approval.service_id, approval.human_rendering);
      const sig = this.sign(payload);
      store.db
        .prepare("UPDATE approvals SET sig = ? WHERE projection_hash = ?")
        .run(sig, approval.projection_hash);
    }
  }

  sign(payload: string): string {
    const signature = cryptoSign(null, Buffer.from(payload, "utf8"), this.privateKey);
    return signature.toString("base64");
  }

  verify(payload: string, signatureB64: string, publicKeyPem?: string): boolean {
    try {
      const key: Parameters<typeof cryptoVerify>[2] = publicKeyPem
        ? { key: publicKeyPem, format: "pem", type: "spki" }
        : this.publicKey;
      return cryptoVerify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signatureB64, "base64"));
    } catch {
      return false;
    }
  }

  getPublicKeyPem(): string {
    return this.publicKey.export({ type: "spki", format: "pem" }) as string;
  }
}

function allGrants(store: StateStore) {
  return store.db.prepare("SELECT * FROM grants WHERE revoked_at IS NULL").all() as Array<{
    id: number;
    plugin_id: string;
    cap: string;
    scope_json: string;
  }>;
}

export function canonicalTrustRecordPayload(
  pluginId: string,
  version: string,
  sha256: string,
  grantedCapsJson: string,
): string {
  return JSON.stringify({
    pluginId,
    version,
    sha256,
    grantedCaps: JSON.parse(grantedCapsJson),
  });
}

export function canonicalGrantPayload(pluginId: string, cap: string, scopeJson: string): string {
  return JSON.stringify({ pluginId, cap, scope: JSON.parse(scopeJson) });
}

export function canonicalApprovalPayload(projectionHash: string, serviceId: string, humanRendering: string): string {
  return JSON.stringify({ projectionHash, serviceId, humanRendering });
}
