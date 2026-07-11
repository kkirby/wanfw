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

export function matchZone(zones: string[], zone: string): boolean {
  return zones.includes(zone);
}

export function matchPort(ports: number[], port: number): boolean {
  return ports.includes(port);
}

export function matchPortRange(ports: number[], requested: number[]): boolean {
  return requested.every((p) => matchPort(ports, p));
}
