import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateStore } from "../state-store/store.js";
import type { JsonValue } from "@wanfw/core-schemas";

export interface ManifestDependencies {
  settings?: Record<string, JsonValue>;
  roles?: string[];
  plugins?: string[];
}

export interface ManifestLike {
  id: string;
  types?: string[];
  dependencies?: ManifestDependencies;
}

export interface FrameworkSpec {
  deploymentMode?: string;
  roles?: Record<string, string>;
  [key: string]: JsonValue | undefined;
}

export type DependencyErrorKind = "setting" | "role" | "plugin" | "cycle" | "unimplemented";

export interface DependencyError {
  pluginId: string;
  kind: DependencyErrorKind;
  message: string;
}

export interface ResolutionResult {
  ok: boolean;
  errors: DependencyError[];
}

async function readManifest(bundlesDir: string, sha256: string): Promise<ManifestLike | undefined> {
  try {
    const raw = await readFile(join(bundlesDir, sha256, "manifest.json"), "utf8");
    return JSON.parse(raw) as ManifestLike;
  } catch {
    return undefined;
  }
}

/**
 * Generic dependency-graph resolution over dependencies.settings /
 * dependencies.roles / dependencies.plugins (§6.3). Knows nothing about
 * specific capability names or plugin types -- it only checks the
 * declared dependency shape against the framework document and the set
 * of currently role-bound plugins. Structured errors name exactly what
 * is missing (§6.3 example: "cert-letsencrypt-dns01 requires
 * deploymentMode=subdomain; current: port").
 *
 * Atomicity (plan requirement): this function is pure and returns a
 * complete report; the caller enforces "a role binding whose transitive
 * dependencies fail is rejected whole" by only proceeding when `ok` is
 * true. Nothing here partially applies anything.
 */
export async function resolveDependencies(
  store: StateStore,
  bundlesDir: string,
  framework: FrameworkSpec,
): Promise<ResolutionResult> {
  const errors: DependencyError[] = [];
  const roles = framework.roles ?? {};
  const boundPluginIds = new Set(Object.values(roles));

  // Load manifests for every currently role-bound, trusted plugin.
  const trustedByPluginId = new Map(store.listTrustRecords().map((r) => [r.plugin_id, r]));
  const manifestsByPluginId = new Map<string, ManifestLike>();

  for (const pluginId of boundPluginIds) {
    const trust = trustedByPluginId.get(pluginId);
    if (!trust) {
      errors.push({
        pluginId,
        kind: "plugin",
        message: `role binding references '${pluginId}', which is not currently trusted`,
      });
      continue;
    }
    const manifest = await readManifest(bundlesDir, trust.sha256);
    if (manifest) manifestsByPluginId.set(pluginId, manifest);
  }

  // v1.1 stub: deploymentMode=port validates against the schema enum but is
  // not implemented; flag it as a config-time error at resolve time rather
  // than a silent downgrade (plan interpretation, veto item 2).
  if (framework.deploymentMode === "port") {
    errors.push({
      pluginId: "framework",
      kind: "unimplemented",
      message: "deploymentMode=port is modeled but not implemented until v1.1",
    });
  }

  for (const [pluginId, manifest] of manifestsByPluginId) {
    const deps = manifest.dependencies;
    if (!deps) continue;

    if (deps.settings) {
      for (const [key, expected] of Object.entries(deps.settings)) {
        const actual = framework[key];
        if (actual !== expected) {
          errors.push({
            pluginId,
            kind: "setting",
            message: `${pluginId} requires ${key}=${JSON.stringify(expected)}; current: ${JSON.stringify(actual)}`,
          });
        }
      }
    }

    if (deps.roles) {
      for (const requiredRole of deps.roles) {
        if (!roles[requiredRole]) {
          errors.push({
            pluginId,
            kind: "role",
            message: `${pluginId} requires a '${requiredRole}' role to be bound; none is`,
          });
        }
      }
    }

    if (deps.plugins) {
      for (const requiredPluginId of deps.plugins) {
        if (!trustedByPluginId.has(requiredPluginId)) {
          errors.push({
            pluginId,
            kind: "plugin",
            message: `${pluginId} requires plugin '${requiredPluginId}' to be trusted; it is not`,
          });
        }
      }
    }
  }

  const cycle = detectCycle(manifestsByPluginId, roles);
  if (cycle) {
    errors.push({
      pluginId: cycle[0]!,
      kind: "cycle",
      message: `dependency cycle detected: ${cycle.join(" -> ")}`,
    });
  }

  return { ok: errors.length === 0, errors };
}

/** DFS cycle detection over the plugins.dependencies.plugins graph among currently role-bound plugins. */
function detectCycle(manifestsByPluginId: Map<string, ManifestLike>, roles: Record<string, string>): string[] | undefined {
  const graph = new Map<string, string[]>();
  for (const [pluginId, manifest] of manifestsByPluginId) {
    const edges: string[] = [...(manifest.dependencies?.plugins ?? [])];
    for (const requiredRole of manifest.dependencies?.roles ?? []) {
      const boundId = roles[requiredRole];
      if (boundId) edges.push(boundId);
    }
    graph.set(pluginId, edges);
  }

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const path: string[] = [];

  function visit(node: string): string[] | undefined {
    color.set(node, GRAY);
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const cycleStart = path.indexOf(next);
        return [...path.slice(cycleStart), next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    color.set(node, BLACK);
    return undefined;
  }

  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return undefined;
}

/** v1.1 stub check for a single service document (plan interpretation: quarantine ships v1.1). */
export function checkServiceExposeStub(isolationTier: string | undefined): DependencyError | undefined {
  if (isolationTier === "quarantine") {
    return {
      pluginId: "core",
      kind: "unimplemented",
      message: "isolationTier=quarantine is modeled but not implemented until v1.1",
    };
  }
  return undefined;
}
