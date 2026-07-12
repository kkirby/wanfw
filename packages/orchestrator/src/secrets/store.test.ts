import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { putSecret, getSecret, unsetSecret, listSecrets } from "./store.js";

describe("secrets store (§12.4)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "wanfw-secrets-"));
    dirs.push(dir);
    return dir;
  }

  it("put then get round-trips the value", () => {
    const dir = freshDir();
    putSecret(dir, "cert-letsencrypt-dns01/acme-account-key", "the-value");
    expect(getSecret(dir, "cert-letsencrypt-dns01/acme-account-key")).toBe("the-value");
  });

  it("get returns undefined for a name that was never set", () => {
    const dir = freshDir();
    expect(getSecret(dir, "nope/nope")).toBeUndefined();
  });

  it("unset removes the secret", () => {
    const dir = freshDir();
    putSecret(dir, "ns/k", "v");
    unsetSecret(dir, "ns/k");
    expect(getSecret(dir, "ns/k")).toBeUndefined();
  });

  it("unset on a never-set name is a harmless no-op", () => {
    const dir = freshDir();
    expect(() => unsetSecret(dir, "ns/never-set")).not.toThrow();
  });

  it("directory mode is 0700 and file mode is 0600", () => {
    const dir = freshDir();
    putSecret(dir, "ns/k", "v");
    const dirMode = statSync(join(dir, "ns")).mode & 0o777;
    const fileMode = statSync(join(dir, "ns", "k")).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("listSecrets returns every namespaced name and a lastRotated timestamp, never the value", () => {
    const dir = freshDir();
    putSecret(dir, "cert-letsencrypt-dns01/acme-account-key", "v1");
    putSecret(dir, "dns-namecheap/api-key", "v2");

    const list = listSecrets(dir);
    expect(list.map((s) => s.name)).toEqual(["cert-letsencrypt-dns01/acme-account-key", "dns-namecheap/api-key"]);
    for (const entry of list) {
      expect(entry).not.toHaveProperty("value");
      expect(new Date(entry.lastRotated).toString()).not.toBe("Invalid Date");
    }
  });

  it("listSecrets on an empty/nonexistent store returns an empty array", () => {
    const dir = freshDir();
    expect(listSecrets(join(dir, "nonexistent"))).toEqual([]);
  });

  it("a rotation (re-put) updates lastRotated", async () => {
    const dir = freshDir();
    putSecret(dir, "ns/k", "v1");
    const first = listSecrets(dir)[0]!.lastRotated;
    await new Promise((r) => setTimeout(r, 10));
    putSecret(dir, "ns/k", "v2");
    const second = listSecrets(dir)[0]!.lastRotated;
    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());
    expect(getSecret(dir, "ns/k")).toBe("v2");
  });
});
