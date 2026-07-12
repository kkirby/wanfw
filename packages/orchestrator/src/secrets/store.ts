import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, rmSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Secrets store (§12.4, veto item 5): files at `wanfw_secrets/<pluginOrCore>/<name>`,
 * directory mode 0700, files mode 0600. `name` here is the full namespaced
 * identifier a grant scope matches against (e.g. `cert-letsencrypt-dns01/acme-account-key`
 * per §9's own example), matching the plugin-namespaced convention
 * `matchNamePrefix` already documents in scope-matcher.ts. This module is
 * pure filesystem I/O -- capability gating happens one layer up, in the
 * host API dispatcher (for plugin reads) and the admin socket (for CLI
 * set/unset/list), never here.
 */

export interface SecretListEntry {
  name: string; // "<pluginOrCore>/<secretName>"
  lastRotated: string;
}

function secretPath(secretsDir: string, name: string): string {
  // name is already "<pluginOrCore>/<secretName>"; join preserves that as
  // the two-level directory structure the spec requires.
  return join(secretsDir, name);
}

export function putSecret(secretsDir: string, name: string, value: string): void {
  const path = secretPath(secretsDir, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600); // mkdir/writeFileSync mode can be umask-clamped; enforce explicitly
}

export function getSecret(secretsDir: string, name: string): string | undefined {
  const path = secretPath(secretsDir, name);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

export function unsetSecret(secretsDir: string, name: string): void {
  rmSync(secretPath(secretsDir, name), { force: true });
}

/** Lists every secret under the store (names only, never values) -- used by the admin socket's list route and, transitively, tier1's read-only secrets page. */
export function listSecrets(secretsDir: string): SecretListEntry[] {
  const entries: SecretListEntry[] = [];
  if (!existsSync(secretsDir)) return entries;
  for (const namespace of readdirSync(secretsDir)) {
    const namespaceDir = join(secretsDir, namespace);
    if (!statSync(namespaceDir).isDirectory()) continue;
    for (const secretName of readdirSync(namespaceDir)) {
      const fullPath = join(namespaceDir, secretName);
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;
      entries.push({ name: `${namespace}/${secretName}`, lastRotated: stat.mtime.toISOString() });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
