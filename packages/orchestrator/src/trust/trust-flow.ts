import type { Manifest } from "@wanfw/core-schemas";
import type { StateStore } from "../state-store/store.js";
import type { AuditLog } from "../audit-log.js";
import {
  canonicalGrantPayload,
  canonicalTrustRecordPayload,
  type SigningKeyManager,
} from "../signing-key.js";
import { findStagedBundle } from "./staging.js";
import { copyBundleInto } from "./copy-bundle.js";
import { writeBundleFiles, type BundleFile } from "./write-bundle-files.js";

export class TrustFlowError extends Error {}

export interface TrustFlowDeps {
  store: StateStore;
  signingKey: SigningKeyManager;
  auditLog: AuditLog;
  stagingDir: string;
  bundlesDir: string;
}

export interface CapabilityDiffEntry {
  cap: string;
  reason: string;
}

export interface TrustResult {
  pluginId: string;
  version: string;
  sha256: string;
  grantedCaps: string[];
  /** Present when this trust call replaces a previously-trusted version of the same plugin. */
  upgradeDiff?: { added: CapabilityDiffEntry[]; removed: CapabilityDiffEntry[] };
}

function computeUpgradeDiff(previous: Manifest | undefined, next: Manifest): TrustResult["upgradeDiff"] {
  if (!previous) return undefined;
  const prevCaps = new Set(previous.capabilities.map((c) => c.cap));
  const nextCaps = new Set(next.capabilities.map((c) => c.cap));
  const added = next.capabilities.filter((c) => !prevCaps.has(c.cap)).map((c) => ({ cap: c.cap, reason: c.reason }));
  const removed = previous.capabilities
    .filter((c) => !nextCaps.has(c.cap))
    .map((c) => ({ cap: c.cap, reason: c.reason }));
  return { added, removed };
}

function recordTrustAndGrants(deps: TrustFlowDeps, manifest: Manifest, sha256: string): void {
  const now = new Date().toISOString();
  const grantedCapsJson = JSON.stringify(manifest.capabilities.map((c) => c.cap));

  deps.store.insertTrustRecord({
    plugin_id: manifest.id,
    version: manifest.version,
    sha256,
    granted_caps_json: grantedCapsJson,
    sig: deps.signingKey.sign(canonicalTrustRecordPayload(manifest.id, manifest.version, sha256, grantedCapsJson)),
    created_at: now,
  });

  for (const cap of manifest.capabilities) {
    const scopeJson = JSON.stringify(cap.scope);
    deps.store.insertGrant({
      plugin_id: manifest.id,
      cap: cap.cap,
      scope_json: scopeJson,
      sig: deps.signingKey.sign(canonicalGrantPayload(manifest.id, cap.cap, scopeJson)),
      created_at: now,
    });
  }
}

function previousTrustedManifest(store: StateStore, pluginId: string): Manifest | undefined {
  const live = store.listTrustRecords().filter((r) => r.plugin_id === pluginId);
  if (live.length === 0) return undefined;
  const latest = live[live.length - 1]!;
  return {
    manifestVersion: 1,
    id: latest.plugin_id,
    version: latest.version,
    frameworkApi: "^1.0",
    types: [],
    entrypoint: "",
    runtime: "node22",
    capabilities: (JSON.parse(latest.granted_caps_json) as string[]).map((cap) => ({ cap, scope: {}, reason: "" })),
  };
}

/**
 * `wanfwctl plugin trust <id>@<hash>`: the staged bundle must match both id
 * and hash exactly (invariant: staging a different bundle after trust
 * changes nothing, since the pinned hash no longer matches anything
 * staged). Copies into wanfw_bundles/<sha256>/, records trust + grants
 * signed under the current key, audits.
 */
export async function trustStagedBundle(deps: TrustFlowDeps, id: string, sha256: string): Promise<TrustResult> {
  const staged = await findStagedBundle(deps.stagingDir, id, sha256);
  if (!staged || !staged.manifest) {
    throw new TrustFlowError(`no staged bundle matches ${id}@${sha256}`);
  }

  const previous = previousTrustedManifest(deps.store, id);
  await copyBundleInto(staged.bundleDir, deps.bundlesDir, sha256);
  recordTrustAndGrants(deps, staged.manifest, sha256);

  deps.auditLog.append({
    type: "plugin.trust",
    details: { pluginId: id, version: staged.manifest.version, sha256 },
  });

  return {
    pluginId: id,
    version: staged.manifest.version,
    sha256,
    grantedCaps: staged.manifest.capabilities.map((c) => c.cap),
    upgradeDiff: computeUpgradeDiff(previous, staged.manifest),
  };
}

/** `wanfwctl plugin trust --builtin-all`: pulls each built-in's manifest+bytes from the pluginhost and trusts it. */
export async function trustBuiltin(
  deps: TrustFlowDeps,
  builtin: { id: string; version: string; manifest: Manifest; sha256: string; files: BundleFile[] },
): Promise<TrustResult> {
  const previous = previousTrustedManifest(deps.store, builtin.id);
  await writeBundleFiles(deps.bundlesDir, builtin.sha256, builtin.files);
  recordTrustAndGrants(deps, builtin.manifest, builtin.sha256);

  deps.auditLog.append({
    type: "plugin.trust",
    details: { pluginId: builtin.id, version: builtin.version, sha256: builtin.sha256, builtin: true },
  });

  return {
    pluginId: builtin.id,
    version: builtin.version,
    sha256: builtin.sha256,
    grantedCaps: builtin.manifest.capabilities.map((c) => c.cap),
    upgradeDiff: computeUpgradeDiff(previous, builtin.manifest),
  };
}

/** `wanfwctl plugin untrust <id>`: revokes trust + every live grant. Subsequent plans fail validation (T3.6). */
export function untrustPlugin(deps: TrustFlowDeps, id: string): void {
  const live = deps.store.listTrustRecords().filter((r) => r.plugin_id === id);
  if (live.length === 0) {
    throw new TrustFlowError(`plugin ${id} is not currently trusted`);
  }
  for (const record of live) {
    deps.store.revokeTrustRecord(record.plugin_id, record.version);
  }
  for (const grant of deps.store.listGrants(id)) {
    deps.store.revokeGrant(grant.id);
  }
  deps.auditLog.append({ type: "plugin.untrust", details: { pluginId: id } });
}
