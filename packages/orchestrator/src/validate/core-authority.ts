import { computePowerfulProjectionHash, type PowerfulProjectionInput } from "@wanfw/core-schemas";
import type { ContainerSpec } from "./container-spec.js";
import type { ValidationResult } from "./validate-plan.js";

/**
 * Core-emitted scaffolding (per-service networks, the proxy container,
 * cert/proxycfg mounts into the proxy) executes under core authority: it
 * bypasses plugin grant checks entirely (there is no plugin to check --
 * the orchestrator itself emitted this spec), but is still classified,
 * projection-hashed, journaled, and audit-logged exactly like a
 * plugin-emitted plan (§12.1 note). This function exists so that
 * "core-authority" is a named, auditable code path rather than an
 * ad-hoc bypass scattered through EXECUTE.
 */
export function validateCoreEmittedSpec(serviceId: string, spec: ContainerSpec): ValidationResult {
  const powerful = Boolean(
    spec.privileged ||
      spec.networkMode === "host" ||
      (spec.devices && spec.devices.length > 0) ||
      (spec.capAdd && spec.capAdd.length > 0) ||
      (spec.ports && spec.ports.length > 0) ||
      (spec.mounts ?? []).some((m) => m.type === "bind"),
  );

  const result: ValidationResult = {
    ok: true,
    tier: powerful ? "powerful" : "baseline",
    violations: [],
    warnings: [],
  };

  if (powerful) {
    const projectionInput: PowerfulProjectionInput = {
      serviceId,
      image: spec.image,
      mounts: (spec.mounts ?? [])
        .filter((m): m is typeof m & { type: "bind" } => m.type === "bind")
        .map((m) => ({ source: m.source, target: m.target, ro: m.readOnly ?? false })),
      devices: spec.devices ?? [],
      networkMode: spec.networkMode === "host" ? "host" : null,
      privileged: spec.privileged ?? false,
      capAdd: spec.capAdd ?? [],
      publishedPorts: spec.ports ?? [],
    };
    result.projectionHash = computePowerfulProjectionHash(projectionInput);
  }

  return result;
}
