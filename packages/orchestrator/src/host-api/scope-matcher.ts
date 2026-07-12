/**
 * Scope-matching primitives (§12.1). Shared between the T2.7 host API
 * dispatcher (state/log baseline calls) and the T3.6 field-level plan
 * validator (docker.device, docker.mount.bind, dns.record.write, ...).
 *
 * Canonicalization rule: absolute paths only, `..` rejected, no host
 * filesystem access needed -- this is a pure string-level check.
 */

/** Canonicalizes a path string for glob matching. Returns null if it's not a safe absolute path. */
export function canonicalizePath(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.includes("..") || segments.includes(".")) return null;
  return `/${segments.join("/")}`;
}

/**
 * Matches a single glob pattern against a path. Supports a trailing `/*`
 * meaning "this directory or anything under it"; otherwise exact match.
 * Example: pattern `/dev/dri/*` matches `/dev/dri/renderD128` but not `/dev/sda`.
 */
export function matchPathGlob(pattern: string, path: string): boolean {
  const canonicalPath = canonicalizePath(path);
  const canonicalPattern = canonicalizePath(pattern.endsWith("/*") ? pattern.slice(0, -2) || "/" : pattern);
  if (canonicalPath === null || canonicalPattern === null) return false;

  if (pattern.endsWith("/*")) {
    // Root ("/*") is the one case where canonicalPattern itself is "/":
    // every canonicalized path already starts with "/", so it always
    // matches; the general prefix-plus-slash check below would otherwise
    // require a spurious "//" and never match anything.
    if (canonicalPattern === "/") return true;
    return canonicalPath === canonicalPattern || canonicalPath.startsWith(`${canonicalPattern}/`);
  }
  return canonicalPath === canonicalPattern;
}

export function matchAnyPathGlob(patterns: string[], path: string): boolean {
  return patterns.some((p) => matchPathGlob(p, path));
}

/** Name-prefix matching for secrets/plugin-namespaced identifiers, e.g. "cert-letsencrypt-dns01/*". */
export function matchNamePrefix(patterns: string[], name: string): boolean {
  return patterns.some((p) => {
    if (p.endsWith("/*")) return name.startsWith(p.slice(0, -1));
    if (p === "*") return true;
    return p === name;
  });
}

/** Exact match, or "*" for any zone -- same wildcard convention as matchNamePrefix, needed since a cert-issuer's manifest is written before any operator's actual domain is known (T4.4). */
export function matchZone(zones: string[], zone: string): boolean {
  return zones.includes("*") || zones.includes(zone);
}

/**
 * Live capability check for a host API call (§12.1, invariant #8): grants
 * are always the caller's own already-decoded rows loaded fresh from the
 * store for this specific invocation, never trusted from anything the
 * plugin process itself claims. Distinct from VALIDATE's own `hasGrant`
 * twin (validate-plan.ts) -- that one checks an emitted *plan* against
 * stored grants; this one checks a *live call* a running plugin is making
 * right now, but the shape is the same: "cap match, then scope predicate."
 */
export interface DecodedGrant {
  cap: string;
  scope: Record<string, unknown>;
}

export function hasGrant(grants: DecodedGrant[], cap: string, matches: (scope: Record<string, unknown>) => boolean): boolean {
  return grants.some((g) => g.cap === cap && matches(g.scope));
}

export function matchPort(ports: number[], port: number): boolean {
  return ports.includes(port);
}

export function matchPortRange(ports: number[], requested: number[]): boolean {
  return requested.every((p) => matchPort(ports, p));
}
