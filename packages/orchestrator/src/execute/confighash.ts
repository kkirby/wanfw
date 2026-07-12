import { createHash } from "node:crypto";
import { canonicalJSONStringify, type JsonValue } from "@wanfw/core-schemas";
import type { ContainerSpec } from "../validate/index.js";

/**
 * `wanfw.confighash` (ADR-9): sha256 of the *full* canonical ContainerSpec
 * -- every field, not just the powerful-tier subset T0.2's projection hash
 * covers. This is the idempotency key EXECUTE compares against the live
 * object's label: unchanged hash means no-op, changed means recreate.
 * Deliberately a separate hash from the approval projection hash (which
 * exists to decide *whether a human must approve*, not *whether Docker
 * state must change*) -- an env-only edit must recreate the container even
 * though it never needs re-approval.
 */
export function computeConfigHash(spec: ContainerSpec): string {
  const json = canonicalJSONStringify(spec as unknown as JsonValue);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

export function computeNetworkConfigHash(name: string): string {
  return createHash("sha256").update(`network:${name}`, "utf8").digest("hex");
}

export function computeVolumeConfigHash(name: string): string {
  return createHash("sha256").update(`volume:${name}`, "utf8").digest("hex");
}
