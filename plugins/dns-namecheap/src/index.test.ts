import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, applyDnsRecord, getHosts, setHosts, NamecheapApiError, splitZone, type FetchFn, type NamecheapConfig } from "./index.js";

const config: NamecheapConfig = { apiUser: "u", apiKey: "k", username: "u", clientIp: "1.2.3.4" };

function xmlWithHosts(hosts: Array<{ type: string; name: string; address: string; ttl?: string }>): string {
  const hostTags = hosts
    .map((h) => `<host Name="${h.name}" Type="${h.type}" Address="${h.address}" TTL="${h.ttl ?? "1800"}" />`)
    .join("");
  return `<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>${hostTags}</DomainDNSGetHostsResult></CommandResponse></ApiResponse>`;
}

function xmlOk(): string {
  return `<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse><DomainDNSSetHostsResult IsSuccess="true" /></CommandResponse></ApiResponse>`;
}

function xmlError(number: string, message: string): string {
  return `<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="${number}">${message}</Error></Errors></ApiResponse>`;
}

function fakeFetch(responses: string[]): { fetchFn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    const text = responses[i++] ?? responses[responses.length - 1]!;
    return { ok: true, status: 200, text: async () => text };
  };
  return { fetchFn, calls };
}

describe("dns-namecheap plugin (§6.1, §9)", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("dns-namecheap");
  });

  describe("splitZone", () => {
    it("splits a zone into SLD and TLD", () => {
      expect(splitZone("example.tld")).toEqual({ sld: "example", tld: "tld" });
    });

    it("keeps a hyphenated SLD together, splitting only at the last dot", () => {
      expect(splitZone("my-example.tld")).toEqual({ sld: "my-example", tld: "tld" });
    });
  });

  describe("getHosts / setHosts", () => {
    it("getHosts parses every host record out of a real-shaped response", async () => {
      const { fetchFn } = fakeFetch([xmlWithHosts([{ type: "TXT", name: "_acme-challenge", address: "abc123" }])]);
      const hosts = await getHosts(fetchFn, config, "example.tld");
      expect(hosts).toEqual([{ type: "TXT", name: "_acme-challenge", address: "abc123", ttl: "1800" }]);
    });

    it("setHosts sends every record as indexed HostName/RecordType/Address/TTL params", async () => {
      const { fetchFn, calls } = fakeFetch([xmlOk()]);
      await setHosts(fetchFn, config, "example.tld", [{ type: "A", name: "@", address: "1.1.1.1", ttl: "300" }]);
      expect(calls[0]).toContain("HostName1=%40");
      expect(calls[0]).toContain("RecordType1=A");
      expect(calls[0]).toContain("Address1=1.1.1.1");
      expect(calls[0]).toContain("Command=namecheap.domains.dns.setHosts");
    });

    it("throws NamecheapApiError with the raw message for a generic API error", async () => {
      const { fetchFn } = fakeFetch([xmlError("1234567", "Something went wrong")]);
      await expect(getHosts(fetchFn, config, "example.tld")).rejects.toThrow(NamecheapApiError);
      await expect(getHosts(fetchFn, config, "example.tld")).rejects.toThrow(/Something went wrong/);
    });

    it("surfaces the exact 'add this host's WAN IP to the Namecheap API allowlist' message for an IP-allowlist error code (§9's own requirement)", async () => {
      const { fetchFn } = fakeFetch([xmlError("1011150", "IP is not whitelisted")]);
      await expect(getHosts(fetchFn, config, "example.tld")).rejects.toThrow(/allowlist/i);
    });
  });

  describe("applyDnsRecord (dns.apply task, brokered per T4.3)", () => {
    it("action 'set' does a getHosts -> merge -> setHosts round trip, upserting by (type, name)", async () => {
      const { fetchFn, calls } = fakeFetch([xmlWithHosts([{ type: "A", name: "@", address: "1.1.1.1" }]), xmlOk()]);
      await applyDnsRecord(fetchFn, config, {
        zone: "example.tld",
        action: "set",
        record: { type: "TXT", name: "_acme-challenge", value: "challenge-token", ttl: 300 },
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain("getHosts");
      expect(calls[1]).toContain("setHosts");
      // both the pre-existing A record and the new TXT record must be present -- setHosts replaces everything, so losing the A record would be a real outage.
      expect(calls[1]).toContain("RecordType1=A");
      expect(calls[1]).toContain("RecordType2=TXT");
      expect(calls[1]).toContain("Address2=challenge-token");
    });

    it("action 'set' on an existing (type, name) pair replaces it in place rather than duplicating (ACME re-issue re-uses the same TXT name)", async () => {
      const { fetchFn, calls } = fakeFetch([
        xmlWithHosts([{ type: "TXT", name: "_acme-challenge", address: "old-token" }]),
        xmlOk(),
      ]);
      await applyDnsRecord(fetchFn, config, {
        zone: "example.tld",
        action: "set",
        record: { type: "TXT", name: "_acme-challenge", value: "new-token" },
      });
      const setHostsCall = calls[1]!;
      expect(setHostsCall).toContain("Address1=new-token");
      expect(setHostsCall).not.toContain("old-token");
    });

    it("action 'delete' removes the matching record and leaves everything else untouched", async () => {
      const { fetchFn, calls } = fakeFetch([
        xmlWithHosts([
          { type: "A", name: "@", address: "1.1.1.1" },
          { type: "TXT", name: "_acme-challenge", address: "some-token" },
        ]),
        xmlOk(),
      ]);
      await applyDnsRecord(fetchFn, config, {
        zone: "example.tld",
        action: "delete",
        record: { type: "TXT", name: "_acme-challenge", value: "some-token" },
      });
      const setHostsCall = calls[1]!;
      expect(setHostsCall).toContain("RecordType1=A");
      expect(setHostsCall).not.toContain("some-token");
    });

    it("action 'delete' on a record that never existed is a harmless no-op (idempotent cleanup, per T4.4's always-attempt-cleanup requirement)", async () => {
      const { fetchFn, calls } = fakeFetch([xmlWithHosts([{ type: "A", name: "@", address: "1.1.1.1" }]), xmlOk()]);
      await expect(
        applyDnsRecord(fetchFn, config, {
          zone: "example.tld",
          action: "delete",
          record: { type: "TXT", name: "_acme-challenge", value: "never-existed" },
        }),
      ).resolves.toEqual({});
      expect(calls[1]).toContain("RecordType1=A");
    });

    it("propagates the 403/allowlist error message up through applyDnsRecord unchanged", async () => {
      const { fetchFn } = fakeFetch([xmlError("1011150", "IP is not whitelisted")]);
      await expect(
        applyDnsRecord(fetchFn, config, { zone: "example.tld", action: "set", record: { type: "TXT", name: "x", value: "y" } }),
      ).rejects.toThrow(/allowlist/i);
    });
  });
});
