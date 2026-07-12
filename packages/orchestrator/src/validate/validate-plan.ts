import { computePowerfulProjectionHash, type PowerfulProjectionInput } from "@wanfw/core-schemas";
import { matchAnyPathGlob, matchNamePrefix, matchPortRange } from "../host-api/scope-matcher.js";
import type { ContainerSpec } from "./container-spec.js";

export interface Grant {
  cap: string;
  scope: Record<string, unknown>;
}

export type FieldTier = "baseline" | "powerful";

export interface FieldViolation {
  field: string;
  cap: string;
  message: string;
}

export interface Warning {
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  tier: FieldTier;
  violations: FieldViolation[];
  warnings: Warning[];
  projectionHash?: string;
}

const ENV_KEY_SECRET_HEURISTIC = /(_TOKEN|_KEY|_SECRET|PASSWORD)$/i;

function hasGrant(grants: Grant[], cap: string, matches: (scope: Record<string, unknown>) => boolean): boolean {
  return grants.some((g) => g.cap === cap && matches(g.scope));
}

/**
 * Field-by-field validator (§12.1, the authoritative mapping table
 * implemented as code below): every emitted field either requires no
 * capability (baseline, schema-constrained only), requires baseline
 * capability enforced structurally, or requires a powerful-tier grant
 * whose scope must match the emitted value exactly. This runs against
 * the emitting plugin's *stored* grants only -- never anything the
 * invocation payload claims about itself (invariant #8).
 *
 * The canonical adversarial case this defends against (§12.1, ADR-4): a
 * plugin trusted and granted `docker.device` scoped to `/dev/dri/*` emits
 * a plan touching `/dev/sda`. The plugin is honest code executing on
 * malicious config; the grant scope is what stops it, not plugin trust.
 */
export function validateContainerSpec(serviceId: string, spec: ContainerSpec, grants: Grant[]): ValidationResult {
  const violations: FieldViolation[] = [];
  const warnings: Warning[] = [];
  let powerful = false;

  // image: docker.image.pull, baseline, default grant `*` assumed present for deploy-docker.
  if (!hasGrant(grants, "docker.image.pull", (scope) => matchNamePrefix((scope.repos as string[]) ?? [], spec.image))) {
    violations.push({ field: "image", cap: "docker.image.pull", message: `image '${spec.image}' not covered by any docker.image.pull grant` });
  }

  for (const mount of spec.mounts ?? []) {
    if (mount.type === "volume") {
      const expectedPrefix = `wanfw_${serviceId}`;
      if (!mount.source.startsWith(expectedPrefix)) {
        violations.push({
          field: "mounts",
          cap: "docker.volume.named",
          message: `named volume '${mount.source}' is outside this service's namespace (expected prefix '${expectedPrefix}')`,
        });
      }
      // baseline, enforced structurally by the prefix check above -- no grant lookup needed.
    } else {
      powerful = true;
      if (!hasGrant(grants, "docker.mount.bind", (scope) => matchAnyPathGlob((scope.paths as string[]) ?? [], mount.source))) {
        violations.push({
          field: "mounts",
          cap: "docker.mount.bind",
          message: `bind mount source '${mount.source}' not covered by any docker.mount.bind grant`,
        });
      }
    }
  }

  for (const device of spec.devices ?? []) {
    powerful = true;
    if (!device.startsWith("/dev/")) {
      violations.push({ field: "devices", cap: "docker.device", message: `device path '${device}' must match /dev/*` });
      continue;
    }
    if (!hasGrant(grants, "docker.device", (scope) => matchAnyPathGlob((scope.paths as string[]) ?? [], device))) {
      violations.push({
        field: "devices",
        cap: "docker.device",
        message: `device '${device}' not covered by any docker.device grant`,
      });
    }
  }

  if (spec.networkMode === "host") {
    powerful = true;
    if (!hasGrant(grants, "docker.network.host", () => true)) {
      violations.push({ field: "networkMode", cap: "docker.network.host", message: "host networking requires a docker.network.host grant" });
    }
  }

  if (spec.privileged) {
    powerful = true;
    if (!hasGrant(grants, "docker.privileged", () => true)) {
      violations.push({ field: "privileged", cap: "docker.privileged", message: "privileged=true requires a docker.privileged grant" });
    }
  }

  for (const cap of spec.capAdd ?? []) {
    powerful = true;
    if (!hasGrant(grants, "docker.capabilities", (scope) => ((scope.caps as string[]) ?? []).includes(cap))) {
      violations.push({ field: "capAdd", cap: "docker.capabilities", message: `Linux capability '${cap}' not covered by any docker.capabilities grant` });
    }
  }

  if (spec.ports && spec.ports.length > 0) {
    powerful = true;
    if (!hasGrant(grants, "docker.ports.publish", (scope) => matchPortRange((scope.ports as number[]) ?? [], spec.ports!))) {
      violations.push({ field: "ports", cap: "docker.ports.publish", message: `published ports [${spec.ports.join(",")}] not covered by any docker.ports.publish grant` });
    }
  }

  for (const network of spec.networks ?? []) {
    const ownNetwork = `wanfw_svc_${serviceId}`;
    if (network !== ownNetwork) {
      violations.push({
        field: "networks",
        cap: "docker.network.attach",
        message: `network '${network}' is not this service's own network ('${ownNetwork}') or a plan-created network`,
      });
    }
    // baseline, enforced structurally -- no grant lookup needed.
  }

  // env-key heuristic: status warning only, never a gate (spec §12.1).
  for (const key of Object.keys(spec.env ?? {})) {
    if (ENV_KEY_SECRET_HEURISTIC.test(key)) {
      warnings.push({
        field: `env.${key}`,
        message: `env var '${key}' looks like a secret; consider the secrets mechanism (secrets.get/put) instead of a plaintext env value`,
      });
    }
  }

  const result: ValidationResult = {
    ok: violations.length === 0,
    tier: powerful ? "powerful" : "baseline",
    violations,
    warnings,
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
