import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJSONStringify, type JsonValue } from "@wanfw/core-schemas";
import type { SigningKeyManager } from "./signing-key.js";

const GENESIS_HASH = "0".repeat(64);
const CHECKPOINT_INTERVAL = 100;

/** Entry types that are security-relevant per spec §12.3: always checkpointed. */
export const SECURITY_RELEVANT_TYPES = new Set([
  "plugin.trust",
  "plugin.untrust",
  "grant.create",
  "grant.revoke",
  "plan.approve",
  "plan.revoke",
  "key.rotate",
  "key.import",
  "powerful.execute",
  "secret.set",
  "secret.unset",
  "plugin.invoke.refused",
  "framework.uninstall",
]);

export interface AuditEntryInput {
  type: string;
  details: Record<string, JsonValue>;
}

export interface AuditEntry extends AuditEntryInput {
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
  checkpointSig?: string;
}

export interface AuditVerifyResult {
  valid: boolean;
  entryCount: number;
  failedAtSeq?: number;
  reason?: string;
}

function hashableFields(entry: Omit<AuditEntry, "hash" | "checkpointSig">): string {
  return canonicalJSONStringify(entry as unknown as JsonValue);
}

export class AuditLog {
  private logPath: string;
  private getSigningKey: () => SigningKeyManager;
  private seq = 0;
  private lastHash = GENESIS_HASH;

  /**
   * Takes a getter rather than a bare manager: `key import` replaces the
   * live SigningKeyManager instance (rotate() mutates in place, but import
   * swaps the object), so a captured reference would silently go stale.
   */
  constructor(logPath: string, getSigningKey: () => SigningKeyManager) {
    this.logPath = logPath;
    this.getSigningKey = getSigningKey;
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    if (!existsSync(logPath)) {
      closeSync(openSync(logPath, "a", 0o600));
    }
    try {
      chmodSync(logPath, 0o600);
    } catch {
      // best-effort
    }
    const existing = this.readAll();
    if (existing.length > 0) {
      const last = existing[existing.length - 1]!;
      this.seq = last.seq;
      this.lastHash = last.hash;
    }
  }

  append(input: AuditEntryInput): AuditEntry {
    this.seq += 1;
    const base = {
      seq: this.seq,
      ts: new Date().toISOString(),
      type: input.type,
      details: input.details,
      prevHash: this.lastHash,
    };
    const hash = createHash("sha256").update(hashableFields(base), "utf8").digest("hex");

    const isCheckpoint = this.seq % CHECKPOINT_INTERVAL === 0 || SECURITY_RELEVANT_TYPES.has(input.type);
    const entry: AuditEntry = isCheckpoint
      ? { ...base, hash, checkpointSig: this.getSigningKey().sign(hash) }
      : { ...base, hash };

    appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.lastHash = hash;
    return entry;
  }

  readAll(): AuditEntry[] {
    if (!existsSync(this.logPath)) return [];
    const raw = readFileSync(this.logPath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as AuditEntry);
  }

  /** Recomputes the hash chain and checks every checkpoint signature. */
  verify(publicKeyPem?: string): AuditVerifyResult {
    const entries = this.readAll();
    let prevHash = GENESIS_HASH;

    for (const entry of entries) {
      if (entry.prevHash !== prevHash) {
        return { valid: false, entryCount: entries.length, failedAtSeq: entry.seq, reason: "prevHash mismatch" };
      }
      const { hash, checkpointSig, ...base } = entry;
      const recomputedHash = createHash("sha256").update(hashableFields(base), "utf8").digest("hex");
      if (recomputedHash !== hash) {
        return { valid: false, entryCount: entries.length, failedAtSeq: entry.seq, reason: "hash mismatch" };
      }
      if (checkpointSig !== undefined) {
        const sigValid = this.getSigningKey().verify(hash, checkpointSig, publicKeyPem);
        if (!sigValid) {
          return {
            valid: false,
            entryCount: entries.length,
            failedAtSeq: entry.seq,
            reason: "checkpoint signature invalid",
          };
        }
      }
      prevHash = hash;
    }

    return { valid: true, entryCount: entries.length };
  }
}
