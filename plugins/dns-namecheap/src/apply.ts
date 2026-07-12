import { getHosts, setHosts, type DnsHost, type FetchFn, type NamecheapConfig } from "./namecheap-client.js";

export interface DnsApplyInput {
  zone: string; // e.g. "example.tld"
  action: "set" | "delete";
  record: { type: string; name: string; value: string; ttl?: number };
}

export type DnsApplyOutput = Record<string, never>;

function recordKey(h: Pick<DnsHost, "type" | "name">): string {
  return `${h.type}:${h.name}`;
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
  const existing = await getHosts(fetchFn, config, input.zone);
  const key = recordKey(input.record);

  const withoutMatching = existing.filter((h) => recordKey(h) !== key);

  const next =
    input.action === "delete"
      ? withoutMatching
      : [
          ...withoutMatching,
          { type: input.record.type, name: input.record.name, address: input.record.value, ttl: String(input.record.ttl ?? 300) },
        ];

  await setHosts(fetchFn, config, input.zone, next);
  return {};
}
