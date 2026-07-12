export interface DnsApplyInput {
  zone: string;
  action: "set" | "delete";
  record: { type: string; name: string; value: string; ttl?: number };
}

export type DnsApplyOutput = Record<string, never>;

/** POSTs a JSON body and resolves once the response completes; rejects on a non-2xx status or a transport error. */
export type PostJsonFn = (url: string, body: unknown) => Promise<void>;

/**
 * dns.apply for T4.7's Pebble e2e harness: not a real DNS provider at all,
 * but pebble-challtestsrv's management API -- the companion test server
 * Let's Encrypt ships alongside Pebble specifically so ACME clients can be
 * tested end to end without owning real DNS infrastructure. Pebble's own
 * DNS-01 validator queries challtestsrv's fake DNS server directly; this
 * plugin's only job is telling challtestsrv what to answer with, via its
 * `/set-txt` and `/clear-txt` HTTP endpoints (T4.4's real dns-provider
 * plugins do the equivalent against a real DNS API's write endpoint --
 * same broker contract, same `dns.apply` shape, entirely different
 * backend). Only TXT records are supported since that's the only record
 * type DNS-01 challenges ever use.
 */
export async function applyDnsRecord(postJson: PostJsonFn, challSrvUrl: string, input: DnsApplyInput): Promise<DnsApplyOutput> {
  if (input.record.type !== "TXT") {
    throw new Error(`dns-mock only supports TXT records (pebble-challtestsrv has no other record type), got '${input.record.type}'`);
  }
  const host = input.record.name.endsWith(".") ? input.record.name : `${input.record.name}.`;

  if (input.action === "set") {
    await postJson(`${challSrvUrl}/set-txt`, { host, value: input.record.value });
  } else {
    // challtestsrv's /clear-txt clears every TXT value currently set for
    // the host, not just one -- correct for this flow's usage (each ACME
    // authorization owns exactly one _acme-challenge value at a time).
    await postJson(`${challSrvUrl}/clear-txt`, { host });
  }
  return {};
}
