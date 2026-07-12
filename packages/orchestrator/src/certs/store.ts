import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, rmSync, readdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * Cert volume (§6.6, §9, T4.5): `wanfw_certs/<name>/gen-<N>/{fullchain.pem,key.pem}`,
 * with a `current` pointer file naming the active generation -- atomic
 * rename swap on both store and rollback, so a reader never observes a
 * half-written generation or a dangling pointer. The wildcard private key
 * exists in exactly this one place (orchestrator rw, proxy ro per the
 * compose mount) and nowhere else (§9's key-custody requirement) -- this
 * module is the only code in the whole system that ever writes a cert
 * private key to disk.
 */

const RETAINED_GENERATIONS = 3; // previous 3 generations kept for rollback, per the plan's own text

export interface CertMeta {
  names: string[];
  storedAt: string;
  [key: string]: unknown;
}

export interface CertPaths {
  certPath: string;
  keyPath: string;
}

export interface CertListEntry {
  name: string;
  currentGeneration: number;
  generations: number[];
  meta?: CertMeta;
}

function nameDir(certsDir: string, name: string): string {
  return join(certsDir, name);
}

function genDir(certsDir: string, name: string, gen: number): string {
  return join(nameDir(certsDir, name), `gen-${gen}`);
}

function currentPointerPath(certsDir: string, name: string): string {
  return join(nameDir(certsDir, name), "current");
}

function readCurrentGeneration(certsDir: string, name: string): number | undefined {
  const path = currentPointerPath(certsDir, name);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

function writeCurrentGeneration(certsDir: string, name: string, gen: number): void {
  const path = currentPointerPath(certsDir, name);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, String(gen), { mode: 0o640 });
  // Atomic rename swap: a reader of `current` never observes a partially-written value.
  renameSync(tmp, path);
}

function listGenerations(certsDir: string, name: string): number[] {
  const dir = nameDir(certsDir, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.startsWith("gen-") && statSync(join(dir, entry)).isDirectory())
    .map((entry) => Number(entry.slice(4)))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

/**
 * `certs.store(name, certPem, keyPem, meta)`: writes a new generation
 * atomically (write to a temp dir, then rename into place -- the
 * directory rename is the atomicity boundary, same discipline as
 * `@wanfw/core-schemas`' `atomicWriteFile` for single files), retains
 * only the newest `RETAINED_GENERATIONS`, and flips the `current` pointer
 * last (so a reload triggered mid-write can never see an incomplete
 * generation as current).
 */
export function storeCert(certsDir: string, name: string, certPem: string, keyPem: string, meta: Record<string, unknown>): number {
  const existingGenerations = listGenerations(certsDir, name);
  const nextGen = (existingGenerations.at(-1) ?? 0) + 1;

  const finalDir = genDir(certsDir, name, nextGen);
  const tmpDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true, mode: 0o750 });
  writeFileSync(join(tmpDir, "fullchain.pem"), certPem, { mode: 0o640 });
  writeFileSync(join(tmpDir, "key.pem"), keyPem, { mode: 0o640 });
  writeFileSync(join(tmpDir, "meta.json"), JSON.stringify({ ...meta, storedAt: new Date().toISOString() }, null, 2), { mode: 0o640 });
  chmodSync(join(tmpDir, "fullchain.pem"), 0o640);
  chmodSync(join(tmpDir, "key.pem"), 0o640);
  renameSync(tmpDir, finalDir);

  writeCurrentGeneration(certsDir, name, nextGen);

  const allGenerations = [...existingGenerations, nextGen].sort((a, b) => a - b);
  const toPrune = allGenerations.slice(0, Math.max(0, allGenerations.length - RETAINED_GENERATIONS));
  for (const gen of toPrune) {
    rmSync(genDir(certsDir, name, gen), { recursive: true, force: true });
  }

  return nextGen;
}

/** Paths to the CURRENT generation's cert/key, or undefined if no cert has ever been stored under this name. */
export function currentCertPaths(certsDir: string, name: string): CertPaths | undefined {
  const gen = readCurrentGeneration(certsDir, name);
  if (gen === undefined) return undefined;
  const dir = genDir(certsDir, name, gen);
  if (!existsSync(join(dir, "fullchain.pem"))) return undefined;
  return { certPath: join(dir, "fullchain.pem"), keyPath: join(dir, "key.pem") };
}

/** Rolls back to the previous generation (N-1) and flips the current pointer to it. Throws if there is no earlier generation to roll back to. */
export function rollbackCert(certsDir: string, name: string): number {
  const current = readCurrentGeneration(certsDir, name);
  if (current === undefined) throw new Error(`no cert named '${name}' has ever been stored`);
  const generations = listGenerations(certsDir, name);
  const previous = generations.filter((g) => g < current).at(-1);
  if (previous === undefined) throw new Error(`no earlier generation to roll back to for '${name}' (current is gen-${current})`);
  writeCurrentGeneration(certsDir, name, previous);
  return previous;
}

function readMeta(certsDir: string, name: string, gen: number): CertMeta | undefined {
  const path = join(genDir(certsDir, name, gen), "meta.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CertMeta;
  } catch {
    return undefined;
  }
}

export function listCerts(certsDir: string): CertListEntry[] {
  if (!existsSync(certsDir)) return [];
  const names = readdirSync(certsDir).filter((entry) => statSync(join(certsDir, entry)).isDirectory());
  return names
    .map((name) => {
      const generations = listGenerations(certsDir, name);
      const currentGeneration = readCurrentGeneration(certsDir, name) ?? generations.at(-1) ?? 0;
      return { name, currentGeneration, generations, meta: readMeta(certsDir, name, currentGeneration) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
