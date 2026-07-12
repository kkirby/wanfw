import { describe, expect, it } from "vitest";
import { applyDnsRecord, type PostJsonFn } from "./apply.js";

describe("dns-mock apply (T4.7, pebble-challtestsrv backend)", () => {
  it("action:set posts to /set-txt with a trailing-dot host and the TXT value", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const postJson: PostJsonFn = async (url, body) => {
      calls.push({ url, body });
    };
    const result = await applyDnsRecord(postJson, "http://challtestsrv:8055", {
      zone: "example.tld",
      action: "set",
      record: { type: "TXT", name: "_acme-challenge.example.tld", value: "the-key-authorization" },
    });
    expect(result).toEqual({});
    expect(calls).toEqual([
      { url: "http://challtestsrv:8055/set-txt", body: { host: "_acme-challenge.example.tld.", value: "the-key-authorization" } },
    ]);
  });

  it("action:delete posts to /clear-txt", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const postJson: PostJsonFn = async (url, body) => {
      calls.push({ url, body });
    };
    await applyDnsRecord(postJson, "http://challtestsrv:8055", {
      zone: "example.tld",
      action: "delete",
      record: { type: "TXT", name: "_acme-challenge.example.tld", value: "irrelevant-for-delete" },
    });
    expect(calls).toEqual([{ url: "http://challtestsrv:8055/clear-txt", body: { host: "_acme-challenge.example.tld." } }]);
  });

  it("a name already ending in a dot is not double-dotted", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const postJson: PostJsonFn = async (url, body) => {
      calls.push({ url, body });
    };
    await applyDnsRecord(postJson, "http://challtestsrv:8055", {
      zone: "example.tld",
      action: "set",
      record: { type: "TXT", name: "_acme-challenge.example.tld.", value: "v" },
    });
    expect((calls[0]!.body as { host: string }).host).toBe("_acme-challenge.example.tld.");
  });

  it("rejects non-TXT record types since challtestsrv (and DNS-01) never uses anything else", async () => {
    const postJson: PostJsonFn = async () => {};
    await expect(
      applyDnsRecord(postJson, "http://challtestsrv:8055", {
        zone: "example.tld",
        action: "set",
        record: { type: "A", name: "example.tld", value: "1.2.3.4" },
      }),
    ).rejects.toThrow(/only supports TXT records/);
  });

  it("propagates a challtestsrv transport/status error", async () => {
    const postJson: PostJsonFn = async () => {
      throw new Error("challtestsrv http://challtestsrv:8055/set-txt returned 500: boom");
    };
    await expect(
      applyDnsRecord(postJson, "http://challtestsrv:8055", {
        zone: "example.tld",
        action: "set",
        record: { type: "TXT", name: "_acme-challenge.example.tld", value: "v" },
      }),
    ).rejects.toThrow(/returned 500/);
  });
});
