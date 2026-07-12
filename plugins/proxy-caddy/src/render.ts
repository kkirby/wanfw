import type { CertPaths, RenderInput, RenderOutput, RouteEntry } from "./types.js";

/**
 * The service container's Docker DNS name on its own `wanfw_svc_<id>`
 * network -- matches the orchestrator's own container-naming convention in
 * `packages/orchestrator/src/reconciler/execute-stage.ts` (`wanfw_<serviceId>`).
 * This coupling is inherent to the design (§8.4: "reverse_proxy backendHost:backendPort
 * over the service network"), not accidental -- the proxy plugin has no
 * other way to know a service's reachable name.
 */
function backendHost(serviceId: string): string {
  return `wanfw_${serviceId}`;
}

function tlsDirective(cert: CertPaths | undefined): string {
  return cert ? `\ttls ${cert.certPath} ${cert.keyPath}` : `\ttls internal`;
}

function siteBlock(route: RouteEntry, cert: CertPaths | undefined): string {
  return [
    `${route.hostname} {`,
    tlsDirective(cert),
    `\treverse_proxy ${route.backendProtocol}://${backendHost(route.serviceId)}:${route.backendPort}`,
    `}`,
  ].join("\n");
}

/**
 * render (§8.4/§8.5): a Caddyfile with one site block per route plus a
 * catch-all that 404s any unmatched Host -- no backend contact, no
 * service-name leak (§8.5's "Unknown Host = 404" requirement). Falls back
 * to `tls internal` (Caddy's own CA, LAN-only) until a real cert has been
 * issued and stored (T4.5); once `input.cert` is present, the :443 catch-
 * all switches to static `tls cert key` paths from `wanfw_certs` same as
 * every named site. Routes are rendered in the exact order PLAN already
 * sorted them (by serviceId, T3.5) so output is deterministic -- required
 * for the confighash-based idempotency EXECUTE's ensureContainer relies on
 * to decide whether the proxy needs a reload at all.
 *
 * The catch-all is two separate blocks, `:443` and `:80`, not one
 * `:443, :80` block (T4.7 fix, found by live verification once the proxy
 * container was actually mounting its real config for the first time --
 * see `execute/proxy-container.ts`'s own T4.7 comment for why that hadn't
 * happened before): Caddy rejects a single server block that spans both a
 * TLS port and :80 with `server listening on [:80] is HTTP, but attempts
 * to configure TLS connection policies`, since :80 can never speak TLS.
 * Only the :443 block gets a `tls` directive; :80 just 404s in plain HTTP.
 */
export function renderTask(input: RenderInput): RenderOutput {
  const siteBlocks = input.routes.map((route) => siteBlock(route, input.cert));
  const catchAll443 = [":443 {", tlsDirective(input.cert), `\trespond 404`, `}`].join("\n");
  const catchAll80 = [":80 {", `\trespond 404`, `}`].join("\n");

  const content = [...siteBlocks, catchAll443, catchAll80].join("\n\n") + "\n";

  return {
    filename: "Caddyfile",
    content,
    reloadCmd: ["caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
  };
}
