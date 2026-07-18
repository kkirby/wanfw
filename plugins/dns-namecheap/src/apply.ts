import { getHosts, setHosts, registrableZone, type DnsHost, type FetchFn, type NamecheapConfig } from "./namecheap-client.js";

export interface DnsApplyInput {
  zone: string; // e.g. "example.tld" -- the caller's base domain; not necessarily the exact registered Namecheap domain, see registrableZone()
  action: "set" | "delete";
  record: { type: string; name: string; value: string; ttl?: number };
}

export type DnsApplyOutput = Record<string, never>;

function recordKey(h: Pick<DnsHost, "type" | "name">): string {
  return `${h.type}:${h.name}`;
}

/**
 * Callers (cert-letsencrypt-dns01's `txtRecordNameFor`) hand us the
 * ABSOLUTE record name (e.g. "_acme-challenge.kavita.home.example.com"),
 * matching the ADR-1 host-API contract's own docs ("the registrable DNS
 * zone" is a separate concept from the record name). Namecheap's `Name`
 * host-record field, however, is always relative to the SLD.TLD it's
 * managing -- multi-label relative values ARE supported (Namecheap
 * creates the full nested subdomain from a dotted Name, e.g.
 * "_acme-challenge.kavita.home" under domain "example.com" correctly
 * produces "_acme-challenge.kavita.home.example.com"), so stripping just
 * the registrable-zone suffix (not the full requested `zone`, which may
 * itself be a non-registrable subdomain) preserves the rest of the
 * label chain intact.
 */
function relativeToZone(name: string, zone: string): string {
  if (name === zone) return "@";
  const suffix = `.${zone}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

/**
 * dns.apply (§6.1, brokered by the orchestrator per T4.3 -- this plugin
 * never talks to another plugin directly, only to Namecheap's API). Since
 * `setHosts` replaces the whole record set, this always does a full
 * getHosts -> merge -> setHosts round trip rather than trying to find an
 * incremental API that doesn't exist. `action: "set"` upserts by
 * `(type, name)` key (a second TXT challenge on the same name replaces the
 * first, matching ACME's own re-issue behavior); `action: "delete"` removes
 * every record matching that key -- always attempted even on cleanup after
 * a failure elsewhere in the issue flow (T4.4's try/finally discipline
 * lives in the cert plugin, not here; this function is just idempotent
 * either way it's called).
 */
export async function applyDnsRecord(fetchFn: FetchFn, config: NamecheapConfig, input: DnsApplyInput): Promise<DnsApplyOutput> {
  const zone = registrableZone(input.zone);
  const relativeName = relativeToZone(input.record.name, zone);
  const existing = await getHosts(fetchFn, config, zone);
  const key = recordKey({ type: input.record.type, name: relativeName });

  const withoutMatching = existing.filter((h) => recordKey(h) !== key);

  const next =
    input.action === "delete"
      ? withoutMatching
      : [...withoutMatching, { type: input.record.type, name: relativeName, address: input.record.value, ttl: String(input.record.ttl ?? 300) }];

  await setHosts(fetchFn, config, zone, next);
  return {};
}
