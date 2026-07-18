import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeCert, currentCertPaths, rollbackCert, listCerts, readRenewalState, writeRenewalState } from "./store.js";

describe("certs store (§6.6, §9, T4.5)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "wanfw-certs-"));
    dirs.push(dir);
    return dir;
  }

  it("storeCert writes gen-1 on first store and currentCertPaths resolves to it", async () => {
    const dir = freshDir();
    const gen = storeCert(dir, "wildcard", "CERT1", "KEY1", { names: ["example.tld"] });
    expect(gen).toBe(1);

    const paths = currentCertPaths(dir, "wildcard");
    expect(paths).toBeDefined();
    expect(await readFile(paths!.certPath, "utf8")).toBe("CERT1");
    expect(await readFile(paths!.keyPath, "utf8")).toBe("KEY1");
  });

  it("currentCertPaths returns undefined for a name that was never stored", () => {
    const dir = freshDir();
    expect(currentCertPaths(dir, "never-stored")).toBeUndefined();
  });

  it("a second store increments the generation and currentCertPaths tracks the new one", async () => {
    const dir = freshDir();
    storeCert(dir, "wildcard", "CERT1", "KEY1", {});
    const gen2 = storeCert(dir, "wildcard", "CERT2", "KEY2", {});
    expect(gen2).toBe(2);

    const paths = currentCertPaths(dir, "wildcard");
    expect(await readFile(paths!.certPath, "utf8")).toBe("CERT2");
  });

  it("cert and key files are written with mode 0640", () => {
    const dir = freshDir();
    storeCert(dir, "wildcard", "CERT1", "KEY1", {});
    const paths = currentCertPaths(dir, "wildcard")!;
    expect(statSync(paths.certPath).mode & 0o777).toBe(0o640);
    expect(statSync(paths.keyPath).mode & 0o777).toBe(0o640);
  });

  it("retains only the previous 3 generations, pruning older ones", () => {
    const dir = freshDir();
    for (let i = 1; i <= 5; i++) storeCert(dir, "wildcard", `CERT${i}`, `KEY${i}`, {});
    const entry = listCerts(dir).find((e) => e.name === "wildcard")!;
    expect(entry.generations).toEqual([3, 4, 5]); // gen-1 and gen-2 pruned
    expect(entry.currentGeneration).toBe(5);
  });

  it("rollbackCert restores generation N-1 and currentCertPaths reflects it immediately", async () => {
    const dir = freshDir();
    storeCert(dir, "wildcard", "CERT1", "KEY1", {});
    storeCert(dir, "wildcard", "CERT2", "KEY2", {});

    const rolledBackTo = rollbackCert(dir, "wildcard");
    expect(rolledBackTo).toBe(1);

    const paths = currentCertPaths(dir, "wildcard")!;
    expect(await readFile(paths.certPath, "utf8")).toBe("CERT1");
  });

  it("rollbackCert throws when there is no earlier generation", () => {
    const dir = freshDir();
    storeCert(dir, "wildcard", "CERT1", "KEY1", {});
    expect(() => rollbackCert(dir, "wildcard")).toThrow(/no earlier generation/);
  });

  it("rollbackCert throws for a name that was never stored", () => {
    const dir = freshDir();
    expect(() => rollbackCert(dir, "never-stored")).toThrow(/has ever been stored/);
  });

  it("a rollback then a fresh store creates a new generation on top (gen-3), not overwriting gen-2 -- rollback moves the pointer, it doesn't delete history", async () => {
    const dir = freshDir();
    storeCert(dir, "wildcard", "CERT1", "KEY1", {});
    storeCert(dir, "wildcard", "CERT2", "KEY2", {});
    rollbackCert(dir, "wildcard");
    const gen3 = storeCert(dir, "wildcard", "CERT3", "KEY3", {});
    expect(gen3).toBe(3);
    const paths = currentCertPaths(dir, "wildcard")!;
    expect(await readFile(paths.certPath, "utf8")).toBe("CERT3");
  });

  it("listCerts reports every stored name, its generations, current generation, and meta", () => {
    const dir = freshDir();
    storeCert(dir, "wildcard", "CERT1", "KEY1", { names: ["example.tld", "*.example.tld"] });
    const entries = listCerts(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("wildcard");
    expect(entries[0]!.currentGeneration).toBe(1);
    expect(entries[0]!.meta?.names).toEqual(["example.tld", "*.example.tld"]);
  });

  it("listCerts reports a zero-state renewal default when no renewal attempt has ever been recorded", () => {
    const dir = freshDir();
    storeCert(dir, "wildcard", "CERT1", "KEY1", {});
    const entry = listCerts(dir).find((e) => e.name === "wildcard")!;
    expect(entry.renewal).toEqual({ consecutiveFailures: 0 });
  });

  it("listCerts surfaces a recorded renewal failure's error and retry count", () => {
    const dir = freshDir();
    storeCert(dir, "wildcard", "CERT1", "KEY1", {});
    writeRenewalState(dir, "wildcard", {
      consecutiveFailures: 2,
      lastAttemptAt: "2026-07-12T00:00:00.000Z",
      lastError: { code: "acme_error", message: "rate limited" },
    });

    const entry = listCerts(dir).find((e) => e.name === "wildcard")!;
    expect(entry.renewal).toEqual({
      consecutiveFailures: 2,
      lastAttemptAt: "2026-07-12T00:00:00.000Z",
      lastError: { code: "acme_error", message: "rate limited" },
    });
  });

  it("listCerts on an empty/nonexistent store returns an empty array", () => {
    const dir = freshDir();
    expect(listCerts(join(dir, "nonexistent"))).toEqual([]);
  });

  it("two different cert names are stored independently", async () => {
    const dir = freshDir();
    storeCert(dir, "wildcard", "WILDCARD-CERT", "WILDCARD-KEY", {});
    storeCert(dir, "quarantine-service", "QUARANTINE-CERT", "QUARANTINE-KEY", {});
    expect(await readFile(currentCertPaths(dir, "wildcard")!.certPath, "utf8")).toBe("WILDCARD-CERT");
    expect(await readFile(currentCertPaths(dir, "quarantine-service")!.certPath, "utf8")).toBe("QUARANTINE-CERT");
  });

  it("readRenewalState returns a fresh zero-state for a name with no recorded attempts", () => {
    const dir = freshDir();
    expect(readRenewalState(dir, "wildcard")).toEqual({ consecutiveFailures: 0 });
  });

  it("writeRenewalState then readRenewalState round-trips exactly, even without a cert ever being stored", () => {
    const dir = freshDir();
    writeRenewalState(dir, "wildcard", { lastAttemptAt: "2026-07-12T00:00:00Z", lastSuccessAt: "2026-07-12T00:00:00Z", consecutiveFailures: 0 });
    expect(readRenewalState(dir, "wildcard")).toEqual({
      lastAttemptAt: "2026-07-12T00:00:00Z",
      lastSuccessAt: "2026-07-12T00:00:00Z",
      consecutiveFailures: 0,
    });
  });

  it("writeRenewalState overwrites the previous state", () => {
    const dir = freshDir();
    writeRenewalState(dir, "wildcard", { consecutiveFailures: 1, lastAttemptAt: "2026-07-12T00:00:00Z" });
    writeRenewalState(dir, "wildcard", { consecutiveFailures: 2, lastAttemptAt: "2026-07-12T01:00:00Z" });
    expect(readRenewalState(dir, "wildcard")).toEqual({ consecutiveFailures: 2, lastAttemptAt: "2026-07-12T01:00:00Z" });
  });
});
