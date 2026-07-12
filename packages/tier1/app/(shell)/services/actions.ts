"use server";

import { redirect } from "next/navigation";
import { getComposedSchema } from "../../../lib/orch";
import { deleteServiceDoc, readServiceDoc, writeServiceDoc } from "../../../lib/desired-write";
import { validateDocument } from "../../../lib/schema-form/validate";
import type { JsonSchemaLike } from "../../../lib/schema-form/types";

export interface SaveServiceResult {
  ok: boolean;
  errorsByPath?: Record<string, string[]>;
  formError?: string;
}

/**
 * Create/edit a service (§10.1, §5.6 write-back): validates the draft
 * against the composed schema (Ajv, client-UX-only per §5.5 -- the
 * orchestrator's own VALIDATE stage remains the real authority), then
 * atomically writes wanfw_desired/services/<id>.json and nudges the
 * reconciler. `plugin` is filled in from the composed schema's currently
 * bound deploy plugin -- the form itself never asks the operator to name it.
 */
export async function saveServiceAction(
  id: string,
  displayName: string,
  spec: Record<string, unknown>,
): Promise<SaveServiceResult> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return { ok: false, formError: "service id must be lowercase alphanumeric with hyphens" };
  }

  const composed = await getComposedSchema();
  if (!composed) {
    return { ok: false, formError: "could not reach the orchestrator to fetch the composed schema" };
  }
  if (!composed.boundDeployPluginId) {
    return { ok: false, formError: "no deploy plugin is currently trusted/bound -- trust one first" };
  }

  const deploy = { ...(spec.deploy as Record<string, unknown> | undefined), plugin: composed.boundDeployPluginId };
  const draft = { ...spec, deploy };

  const result = validateDocument(composed.service as JsonSchemaLike, draft);
  if (!result.valid) {
    return { ok: false, errorsByPath: result.errorsByPath };
  }

  await writeServiceDoc(id, draft, displayName || undefined);
  return { ok: true };
}

export async function deleteServiceAction(id: string, removeVolumesOnDelete: boolean): Promise<void> {
  if (removeVolumesOnDelete) {
    const doc = await readServiceDoc(id);
    if (doc) {
      const expose = (doc.spec.expose as Record<string, unknown> | undefined) ?? {};
      // Persist the choice one last time before deleting so EXECUTE's
      // volume-labeling (T3.8/T3.9) sees it on this final reconcile pass
      // -- the flag has to be on the object at delete time, not looked up
      // afterward, since the service doc itself is about to disappear.
      await writeServiceDoc(id, { ...doc.spec, expose: { ...expose, removeVolumesOnDelete: true } }, doc.metadata.displayName);
      await new Promise((r) => setTimeout(r, 500)); // let one reconcile relabel the volume before the doc vanishes
    }
  }
  await deleteServiceDoc(id);
  redirect("/services");
}
