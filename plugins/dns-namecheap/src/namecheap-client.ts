/**
 * Minimal Namecheap XML API client (§6.1, §9 Namecheap specifics). Namecheap's
 * `domains.dns.setHosts` replaces the *entire* host record set for a domain
 * in one call -- there is no incremental add/remove endpoint -- so applying
 * a single record change is always: getHosts -> merge in memory -> setHosts
 * with the full merged list.
 *
 * A hand-rolled regex-based XML reader, not a general parser: Namecheap's
 * response shape is fixed and well-documented (flat `<host .../>` self-closing
 * tags inside `<DomainDNSGetHostsResult>`, `<Errors><Error Number="...">`),
 * so a full XML parser dependency would be solving a much bigger problem
 * than this API actually poses.
 */

export interface NamecheapConfig {
  apiUser: string;
  apiKey: string;
  username: string;
  clientIp: string;
  baseUrl?: string; // overridable for tests / sandbox API
}

export interface DnsHost {
  type: string; // "A" | "TXT" | "CNAME" | ...
  name: string; // subdomain part only, e.g. "_acme-challenge", "@" for apex
  address: string;
  ttl: string;
}

export class NamecheapApiError extends Error {
  constructor(
    message: string,
    public readonly errorNumber?: string,
  ) {
    super(message);
  }
}

/** Error numbers Namecheap returns for IP-allowlist/auth problems (§9's "add this host's WAN IP" case). */
const IP_ALLOWLIST_ERROR_NUMBERS = new Set(["1011150", "1010900"]);

function splitZone(zone: string): { sld: string; tld: string } {
  const parts = zone.split(".");
  if (parts.length < 2) throw new Error(`invalid zone '${zone}': expected at least 'sld.tld'`);
  return { sld: parts.slice(0, -1).join("."), tld: parts[parts.length - 1]! };
}

/**
 * Namecheap's DNS API only ever operates at the registered SLD.TLD level --
 * it has no concept of a delegated subdomain managed as its own zone. A
 * `zone` with more than two labels (e.g. "home.example.com", a common
 * "put the whole homelab under one subdomain of the domain I actually
 * registered" pattern) has to be reduced to the last two labels
 * ("example.com") before it's usable as an SLD/TLD pair -- passing the
 * full value through `splitZone` unchanged instead produces a bogus SLD
 * like "home.example" that Namecheap rejects with "Domain name not
 * found", found live against a real deployment.
 *
 * This is a plain last-two-labels heuristic, not a public-suffix-list
 * lookup, so it's wrong for compound TLDs (e.g. "example.co.uk" would
 * incorrectly reduce to "co.uk") -- a known, documented limitation
 * consistent with this client's own "minimal, not a general parser"
 * scope (see module doc comment). A wrong guess fails loud, as a real
 * Namecheap API error, rather than silently touching the wrong domain.
 */
export function registrableZone(zone: string): string {
  const parts = zone.split(".");
  return parts.length <= 2 ? zone : parts.slice(-2).join(".");
}

function extractErrors(xml: string): Array<{ number?: string; message: string }> {
  const errors: Array<{ number?: string; message: string }> = [];
  const errorBlockMatch = xml.match(/<Errors>([\s\S]*?)<\/Errors>/);
  if (!errorBlockMatch) return errors;
  const errorTagRe = /<Error(?:\s+Number="([^"]*)")?[^>]*>([\s\S]*?)<\/Error>/g;
  let m: RegExpExecArray | null;
  while ((m = errorTagRe.exec(errorBlockMatch[1]!))) {
    errors.push({ number: m[1], message: m[2]!.trim() });
  }
  return errors;
}

function checkErrors(xml: string): void {
  const errors = extractErrors(xml);
  if (errors.length === 0) return;
  const messages = errors.map((e) => e.message).join("; ");
  const isAllowlistIssue = errors.some((e) => e.number && IP_ALLOWLIST_ERROR_NUMBERS.has(e.number));
  if (isAllowlistIssue) {
    throw new NamecheapApiError(
      `Namecheap API refused the request -- add this host's WAN IP to the Namecheap API allowlist (https://ap.www.namecheap.com/settings/tools/apiaccess/). Underlying error: ${messages}`,
      errors[0]?.number,
    );
  }
  throw new NamecheapApiError(`Namecheap API error: ${messages}`, errors[0]?.number);
}

function parseHosts(xml: string): DnsHost[] {
  const hosts: DnsHost[] = [];
  const hostTagRe = /<host\s+([^/>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = hostTagRe.exec(xml))) {
    const attrs = m[1]!;
    const get = (attr: string): string => {
      const attrMatch = attrs.match(new RegExp(`${attr}="([^"]*)"`, "i"));
      return attrMatch ? attrMatch[1]! : "";
    };
    hosts.push({ type: get("Type"), name: get("Name"), address: get("Address"), ttl: get("TTL") || "1800" });
  }
  return hosts;
}

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function baseParams(config: NamecheapConfig): URLSearchParams {
  return new URLSearchParams({
    ApiUser: config.apiUser,
    ApiKey: config.apiKey,
    UserName: config.username,
    ClientIp: config.clientIp,
  });
}

/** `namecheap.domains.dns.getHosts` -- fetches every current host record for the zone. */
export async function getHosts(fetchFn: FetchFn, config: NamecheapConfig, zone: string): Promise<DnsHost[]> {
  const { sld, tld } = splitZone(zone);
  const params = baseParams(config);
  params.set("Command", "namecheap.domains.dns.getHosts");
  params.set("SLD", sld);
  params.set("TLD", tld);
  const url = `${config.baseUrl ?? "https://api.namecheap.com/xml.response"}?${params.toString()}`;
  const res = await fetchFn(url);
  const text = await res.text();
  checkErrors(text);
  return parseHosts(text);
}

/** `namecheap.domains.dns.setHosts` -- replaces the ENTIRE host record set with `hosts`. */
export async function setHosts(fetchFn: FetchFn, config: NamecheapConfig, zone: string, hosts: DnsHost[]): Promise<void> {
  const { sld, tld } = splitZone(zone);
  const params = baseParams(config);
  params.set("Command", "namecheap.domains.dns.setHosts");
  params.set("SLD", sld);
  params.set("TLD", tld);
  hosts.forEach((h, i) => {
    const n = i + 1;
    params.set(`HostName${n}`, h.name);
    params.set(`RecordType${n}`, h.type);
    params.set(`Address${n}`, h.address);
    params.set(`TTL${n}`, h.ttl);
  });
  const url = `${config.baseUrl ?? "https://api.namecheap.com/xml.response"}?${params.toString()}`;
  const res = await fetchFn(url);
  const text = await res.text();
  checkErrors(text);
}

export { splitZone };
