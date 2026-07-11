import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit-log.js";
import { SigningKeyManager } from "./signing-key.js";

describe("AuditLog", () => {
  const dirs: string[] = [];

  afterEach(() => {
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  async function freshLog(): Promise<{ log: AuditLog; logPath: string; signingKey: SigningKeyManager }> {
    const dir = mkdtempSync(join(tmpdir(), "wanfw-audit-"));
    dirs.push(dir);
    const signingKey = await SigningKeyManager.loadOrCreate(join(dir, "signing.key"));
    const logPath = join(dir, "audit.jsonl");
    const log = new AuditLog(logPath, () => signingKey);
    return { log, logPath, signingKey };
  }

  it("append writes a JSONL entry with an incrementing seq and prevHash chain", async () => {
    const { log } = await freshLog();
    const e1 = log.append({ type: "log.emit", details: { msg: "hello" } });
    const e2 = log.append({ type: "log.emit", details: { msg: "world" } });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);
  });

  it("genesis entry chains from the zero hash", async () => {
    const { log } = await freshLog();
    const e1 = log.append({ type: "log.emit", details: {} });
    expect(e1.prevHash).toBe("0".repeat(64));
  });

  it("security-relevant entries always get a checkpoint signature", async () => {
    const { log } = await freshLog();
    const entry = log.append({ type: "plugin.trust", details: { pluginId: "deploy-docker" } });
    expect(entry.checkpointSig).toBeTruthy();
  });

  it("non-security entries are checkpointed every 100 entries", async () => {
    const { log } = await freshLog();
    let last;
    for (let i = 0; i < 100; i++) {
      last = log.append({ type: "log.emit", details: { i } });
    }
    expect(last!.seq).toBe(100);
    expect(last!.checkpointSig).toBeTruthy();
    // The 99th (non-checkpoint) entry should have no signature.
    const entries = log.readAll();
    expect(entries[98]!.checkpointSig).toBeUndefined();
  });

  it("verify() passes on a clean log", async () => {
    const { log } = await freshLog();
    log.append({ type: "log.emit", details: { a: 1 } });
    log.append({ type: "plugin.trust", details: { pluginId: "x" } });
    log.append({ type: "log.emit", details: { a: 2 } });
    const result = log.verify();
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(3);
  });

  it("verify() fails loudly when a byte in a historical entry is flipped (tamper detection)", async () => {
    const { log, logPath } = await freshLog();
    log.append({ type: "log.emit", details: { a: 1 } });
    log.append({ type: "plugin.trust", details: { pluginId: "x" } });
    log.append({ type: "log.emit", details: { a: 2 } });

    const raw = readFileSync(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    // Flip a byte inside the *first* entry's details field.
    const tampered = JSON.parse(lines[0]!);
    tampered.details.a = 999;
    lines[0] = JSON.stringify(tampered);
    writeFileSync(logPath, lines.join("\n") + "\n");

    const result = log.verify();
    expect(result.valid).toBe(false);
    expect(result.failedAtSeq).toBe(1);
  });

  it("verify() fails when a checkpoint signature is tampered", async () => {
    const { log, logPath } = await freshLog();
    log.append({ type: "plugin.trust", details: { pluginId: "x" } });

    const raw = readFileSync(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const tampered = JSON.parse(lines[0]!);
    tampered.checkpointSig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    lines[0] = JSON.stringify(tampered);
    writeFileSync(logPath, lines.join("\n") + "\n");

    const result = log.verify();
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("checkpoint signature invalid");
  });

  it("resumes seq/hash chain correctly across a process restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wanfw-audit-"));
    dirs.push(dir);
    const signingKey = await SigningKeyManager.loadOrCreate(join(dir, "signing.key"));
    const logPath = join(dir, "audit.jsonl");

    const first = new AuditLog(logPath, () => signingKey);
    const e1 = first.append({ type: "log.emit", details: { a: 1 } });

    const second = new AuditLog(logPath, () => signingKey);
    const e2 = second.append({ type: "log.emit", details: { a: 2 } });

    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);
    expect(second.verify().valid).toBe(true);
  });
});
