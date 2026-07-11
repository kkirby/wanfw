import { createHash } from "node:crypto";
import { canonicalJSONStringify, type JsonValue } from "./canonical-json.js";

export interface BindMount {
  source: string;
  target: string;
  ro: boolean;
}

/**
 * Input to the powerful projection: exactly the powerful-tier fields named
 * in spec §12.2. Baseline fields (env, cmd, labels, resources, restart, ...)
 * are deliberately excluded -- editing them must never change the hash.
 */
export interface PowerfulProjectionInput {
  serviceId: string;
  image: string;
  mounts: BindMount[]; // bind mounts only
  devices: string[];
  networkMode: string | null;
  privileged: boolean;
  capAdd: string[];
  publishedPorts: number[];
}

export interface PowerfulProjection {
  serviceId: string;
  image: string;
  mounts: BindMount[];
  devices: string[];
  networkMode: string | null;
  privileged: boolean;
  capAdd: string[];
  publishedPorts: number[];
}

function sortMounts(mounts: BindMount[]): BindMount[] {
  return [...mounts].sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    if (a.target !== b.target) return a.target < b.target ? -1 : 1;
    return a.ro === b.ro ? 0 : a.ro ? -1 : 1;
  });
}

function sortStrings(values: string[]): string[] {
  return [...values].sort();
}

function sortNumbers(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Build the normalized projection object: sorted arrays, per spec §12.2. */
export function buildPowerfulProjection(input: PowerfulProjectionInput): PowerfulProjection {
  return {
    serviceId: input.serviceId,
    image: input.image,
    mounts: sortMounts(input.mounts),
    devices: sortStrings(input.devices),
    networkMode: input.networkMode,
    privileged: input.privileged,
    capAdd: sortStrings(input.capAdd),
    publishedPorts: sortNumbers(input.publishedPorts),
  };
}

/** Canonical JSON string of the projection (sorted keys + sorted arrays). */
export function projectionToCanonicalJSON(input: PowerfulProjectionInput): string {
  const projection = buildPowerfulProjection(input);
  return canonicalJSONStringify(projection as unknown as JsonValue);
}

/** sha256 hex digest of the canonical projection JSON. */
export function computePowerfulProjectionHash(input: PowerfulProjectionInput): string {
  const json = projectionToCanonicalJSON(input);
  return createHash("sha256").update(json, "utf8").digest("hex");
}
