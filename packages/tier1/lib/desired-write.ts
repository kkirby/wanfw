import "server-only";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "@wanfw/core-schemas";
import { orchRequest } from "./orch";

// The only place in this codebase that writes into wanfw_desired -- tier1
// is explicitly the one component allowed to (the orchestrator never does,
// invariant #10). Every write is followed by POST /nudge so the reconciler
// picks it up immediately rather than waiting for the poll fallback.
const DESIRED_DIR = process.env.WANFW_DESIRED_DIR ?? "/data/desired";

export interface ServiceEnvelope {
  kind: "Service";
  schemaVersion: number;
  metadata: { id: string; displayName?: string };
  spec: Record<string, unknown>;
}

function serviceDocPath(id: string): string {
  return join(DESIRED_DIR, "services", `${id}.json`);
}

export async function listServiceIds(): Promise<string[]> {
  try {
    const files = await readdir(join(DESIRED_DIR, "services"));
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

export async function readServiceDoc(id: string): Promise<ServiceEnvelope | undefined> {
  try {
    const raw = await readFile(serviceDocPath(id), "utf8");
    return JSON.parse(raw) as ServiceEnvelope;
  } catch {
    return undefined;
  }
}

/** Atomic write to wanfw_desired/services/<id>.json (§5.6 write-back), followed by a nudge so the reconciler picks it up immediately. */
export async function writeServiceDoc(id: string, spec: Record<string, unknown>, displayName?: string): Promise<void> {
  const envelope: ServiceEnvelope = {
    kind: "Service",
    schemaVersion: 1,
    metadata: displayName ? { id, displayName } : { id },
    spec,
  };
  await atomicWriteFile(serviceDocPath(id), JSON.stringify(envelope, null, 2));
  await orchRequest("POST", "/nudge");
}

export async function deleteServiceDoc(id: string): Promise<void> {
  await rm(serviceDocPath(id), { force: true });
  await orchRequest("POST", "/nudge");
}
