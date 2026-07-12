import { describe, expect, it } from "vitest";
import { certEnsure, type CertEnsureDeps } from "./cert-ensure.js";
import type { AcmeHttpFn, AcmeHttpResponse } from "./acme-client.js";
import { generateAccountKey } from "./jws.js";
import { generateCsr } from "./csr.js";

/** A minimal in-memory fake ACME server implementing exactly the RFC 8555 subset cert-ensure.ts drives. */
function fakeAcmeServer(options?: { authStatus?: string; failFinalize?: boolean }) {
  const authStatus = options?.authStatus ?? "valid";
  let nonceCounter = 0;
  const calls: Array<{ method: string; url: string }> = [];

  const http: AcmeHttpFn = async (method, url, body) => {
    calls.push({ method, url });
    const nonce = `nonce-${nonceCounter++}`;

    if (url === "https://acme.test/directory") {
      return json(200, { newNonce: "https://acme.test/new-nonce", newAccount: "https://acme.test/new-account", newOrder: "https://acme.test/new-order" }, nonce);
    }
    if (url === "https://acme.test/new-nonce") {
      return { status: 200, headers: { "replay-nonce": nonce }, body: "" };
    }
    if (url === "https://acme.test/new-account") {
      return { status: 201, headers: { "replay-nonce": nonce, location: "https://acme.test/acct/1" }, body: "{}" };
    }
    if (url === "https://acme.test/new-order") {
      return json(201, { status: "pending", authorizations: ["https://acme.test/authz/1"], finalize: "https://acme.test/finalize/1" }, nonce, {
        location: "https://acme.test/order/1",
      });
    }
    if (url === "https://acme.test/authz/1") {
      return json(200, {
        identifier: { type: "dns", value: "example.tld" },
        status: authStatus === "already-valid" ? "valid" : authStatus === "valid" || authStatus === "pending-then-valid" ? "pending" : authStatus,
        challenges: [{ type: "dns-01", url: "https://acme.test/challenge/1", token: "test-token-123", status: authStatus === "already-valid" ? "valid" : "pending" }],
      }, nonce);
    }
    if (url === "https://acme.test/challenge/1") {
      return json(200, { status: "processing" }, nonce);
    }
    if (url === "https://acme.test/order/1") {
      // polled after finalize
      if (options?.failFinalize) {
        return json(200, { status: "invalid" }, nonce);
      }
      return json(200, { status: "valid", authorizations: ["https://acme.test/authz/1"], finalize: "https://acme.test/finalize/1", certificate: "https://acme.test/cert/1" }, nonce);
    }
    if (url === "https://acme.test/finalize/1") {
      return json(200, { status: "processing" }, nonce);
    }
    if (url === "https://acme.test/cert/1") {
      return { status: 200, headers: { "replay-nonce": nonce }, body: "-----BEGIN CERTIFICATE-----\nfakecert\n-----END CERTIFICATE-----\n" };
    }
    throw new Error(`fakeAcmeServer: unhandled URL ${method} ${url} (body: ${body})`);
  };

  // authorization polling: first poll returns "pending" once as set up above,
  // second poll onward returns the terminal status via a mutable counter.
  let authPollCount = 0;
  const originalHttp = http;
  const wrappedHttp: AcmeHttpFn = async (method, url, body) => {
    if (url === "https://acme.test/authz/1" && method === "POST") {
      authPollCount++;
      if (authPollCount === 1) {
        // the very first fetch (before challenge response) -- return pending, matches original above
      } else {
        return json(200, {
          identifier: { type: "dns", value: "example.tld" },
          status: authStatus === "invalid" ? "invalid" : "valid",
          challenges: [{ type: "dns-01", url: "https://acme.test/challenge/1", token: "test-token-123", status: authStatus === "invalid" ? "invalid" : "valid" }],
        }, `nonce-${nonceCounter++}`);
      }
    }
    return originalHttp(method, url, body);
  };

  return { http: wrappedHttp, calls };
}

function json(status: number, body: unknown, nonce: string, extraHeaders: Record<string, string> = {}): AcmeHttpResponse {
  return { status, headers: { "replay-nonce": nonce, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body) };
}

function baseDeps(overrides: Partial<CertEnsureDeps> = {}): { deps: CertEnsureDeps; dnsSetCalls: unknown[]; dnsDeleteCalls: unknown[]; certsStoreCalls: unknown[] } {
  const dnsSetCalls: unknown[] = [];
  const dnsDeleteCalls: unknown[] = [];
  const certsStoreCalls: unknown[] = [];
  const secrets = new Map<string, string>();

  const deps: CertEnsureDeps = {
    http: async () => {
      throw new Error("http not configured for this test");
    },
    directoryUrl: "https://acme.test/directory",
    secretsGet: async (name) => secrets.get(name) ?? null,
    secretsPut: async (name, value) => {
      secrets.set(name, value);
    },
    dnsSetRecord: async (zone, record) => {
      dnsSetCalls.push({ zone, record });
    },
    dnsDeleteRecord: async (zone, record) => {
      dnsDeleteCalls.push({ zone, record });
    },
    dnsQuery: async () => {},
    certsStore: async (name, certPem, keyPem, meta) => {
      certsStoreCalls.push({ name, certPem, keyPem, meta });
    },
    resolveTxt: async () => [],
    sleep: async () => {},
    generateAccountKeyPair: generateAccountKey,
    generateCertKeyPair: generateAccountKey,
    now: (() => {
      let t = 0;
      return () => (t += 1); // monotonically increasing fake clock, avoids any real timing dependency
    })(),
    ...overrides,
  };
  return { deps, dnsSetCalls, dnsDeleteCalls, certsStoreCalls };
}

describe("certEnsure (cert.ensure task, §9 DNS-01 flow)", () => {
  it("full happy path: account creation, order, DNS-01 challenge, finalize, download, certs.store -- and DNS cleanup after success", async () => {
    const server = fakeAcmeServer();
    let propagated = false;
    const { deps, dnsSetCalls, dnsDeleteCalls, certsStoreCalls } = baseDeps({
      http: server.http,
      resolveTxt: async () => {
        // simulate propagation appearing right after dns.setRecord "would" have taken effect
        propagated = true;
        return propagated ? ["placeholder"] : [];
      },
    });
    // resolveTxt needs to return the REAL expected TXT value, not a placeholder -- compute honestly by re-deriving via a second pass is awkward here, so instead assert structurally: dnsSetRecord's own record.value is what resolveTxt should echo back.
    deps.resolveTxt = async (name) => {
      const lastSet = dnsSetCalls.at(-1) as { record: { name: string; value: string } } | undefined;
      if (lastSet && lastSet.record.name === name) return [lastSet.record.value];
      return [];
    };

    const result = await certEnsure(deps, { zone: "example.tld", names: ["example.tld"], certName: "primary" });

    expect(result).toEqual({});
    expect(dnsSetCalls).toHaveLength(1);
    expect(dnsDeleteCalls).toHaveLength(1);
    expect((dnsSetCalls[0] as { record: { name: string } }).record.name).toBe("_acme-challenge.example.tld");
    expect(certsStoreCalls).toHaveLength(1);
    expect((certsStoreCalls[0] as { certPem: string }).certPem).toContain("BEGIN CERTIFICATE");
    expect((certsStoreCalls[0] as { name: string }).name).toBe("primary");
  });

  it("an already-valid (server-reused) authorization skips DNS-01 entirely -- no TXT set, no challenge response attempted (T4.7: Pebble/production LE both reuse authorizations)", async () => {
    const server = fakeAcmeServer({ authStatus: "already-valid" });
    const { deps, dnsSetCalls, dnsDeleteCalls, certsStoreCalls } = baseDeps({ http: server.http });

    const result = await certEnsure(deps, { zone: "example.tld", names: ["example.tld"], certName: "primary" });

    expect(result).toEqual({});
    expect(dnsSetCalls).toHaveLength(0);
    expect(dnsDeleteCalls).toHaveLength(0);
    expect(server.calls.some((c) => c.url === "https://acme.test/challenge/1")).toBe(false);
    expect(certsStoreCalls).toHaveLength(1);
  });

  it("a wildcard identifier ('*.example.tld') challenges under the base domain's _acme-challenge name, not a double-wildcard name", async () => {
    const server = fakeAcmeServer();
    const { deps, dnsSetCalls } = baseDeps({
      http: server.http,
      resolveTxt: async (name) => {
        const lastSet = dnsSetCalls.at(-1) as { record: { name: string; value: string } } | undefined;
        return lastSet && lastSet.record.name === name ? [lastSet.record.value] : [];
      },
    });
    await certEnsure(deps, { zone: "example.tld", names: ["*.example.tld"], certName: "wildcard" });
    expect((dnsSetCalls[0] as { record: { name: string } }).record.name).toBe("_acme-challenge.example.tld");
  });

  it("persists a freshly generated ACME account key to secrets on first run, and reuses the stored one on a later call", async () => {
    const server = fakeAcmeServer();
    const { deps } = baseDeps({
      http: server.http,
      resolveTxt: async () => ["x"],
    });
    // patch resolveTxt to match after dnsSetRecord as above
    let lastSetValue: string | undefined;
    deps.dnsSetRecord = async (_zone, record) => {
      lastSetValue = record.value;
    };
    deps.resolveTxt = async () => (lastSetValue ? [lastSetValue] : []);

    let putCount = 0;
    const originalPut = deps.secretsPut;
    deps.secretsPut = async (name, value) => {
      putCount++;
      await originalPut(name, value);
    };

    await certEnsure(deps, { zone: "example.tld", names: ["example.tld"], certName: "primary" });
    expect(putCount).toBe(1);

    // second call: account key already in "secrets" (baseDeps' Map persists via closures on deps.secretsGet/Put)
    await certEnsure(deps, { zone: "example.tld", names: ["example.tld"], certName: "primary" });
    expect(putCount).toBe(1); // not written again
  });

  it("cleanup-on-failure: a DNS propagation timeout still triggers dns.deleteRecord before the error propagates (try/finally discipline)", async () => {
    const server = fakeAcmeServer();
    const { deps, dnsSetCalls, dnsDeleteCalls } = baseDeps({
      http: server.http,
      resolveTxt: async () => [], // never propagates
      now: (() => {
        let t = 0;
        // advance past POLL_TIMEOUT_MS (10 min) on the very first check inside waitForPropagation's loop
        return () => (t += 11 * 60 * 1000);
      })(),
    });

    await expect(certEnsure(deps, { zone: "example.tld", names: ["example.tld"], certName: "primary" })).rejects.toThrow(/never propagated/);

    expect(dnsSetCalls).toHaveLength(1);
    expect(dnsDeleteCalls).toHaveLength(1); // cleanup still attempted despite the failure
  });

  it("cleanup-on-failure: an ACME authorization going 'invalid' still triggers dns.deleteRecord before the error propagates", async () => {
    const server = fakeAcmeServer({ authStatus: "invalid" });
    const { deps, dnsSetCalls, dnsDeleteCalls } = baseDeps({
      http: server.http,
      resolveTxt: async (name) => {
        const lastSet = dnsSetCalls.at(-1) as { record: { name: string; value: string } } | undefined;
        return lastSet && lastSet.record.name === name ? [lastSet.record.value] : [];
      },
    });

    await expect(certEnsure(deps, { zone: "example.tld", names: ["example.tld"], certName: "primary" })).rejects.toThrow(/did not validate/);

    expect(dnsSetCalls).toHaveLength(1);
    expect(dnsDeleteCalls).toHaveLength(1);
  });

  it("cleanup-on-failure: an unexpected exception mid-validation (e.g. a network error responding to the challenge) still triggers dns.deleteRecord", async () => {
    const server = fakeAcmeServer();
    const explodingHttp: AcmeHttpFn = async (method, url, body) => {
      if (url === "https://acme.test/challenge/1") throw new Error("simulated network failure");
      return server.http(method, url, body);
    };
    const { deps, dnsSetCalls, dnsDeleteCalls } = baseDeps({
      http: explodingHttp,
      resolveTxt: async (name) => {
        const lastSet = dnsSetCalls.at(-1) as { record: { name: string; value: string } } | undefined;
        return lastSet && lastSet.record.name === name ? [lastSet.record.value] : [];
      },
    });

    await expect(certEnsure(deps, { zone: "example.tld", names: ["example.tld"], certName: "primary" })).rejects.toThrow(/simulated network failure/);

    expect(dnsSetCalls).toHaveLength(1);
    expect(dnsDeleteCalls).toHaveLength(1);
  });

  it("cleanup happens BEFORE the function returns/throws, not asynchronously afterward (dnsDeleteRecord is awaited inside the finally block)", async () => {
    const server = fakeAcmeServer({ authStatus: "invalid" });
    const order: string[] = [];
    const { deps, dnsSetCalls } = baseDeps({
      http: server.http,
      resolveTxt: async (name) => {
        const lastSet = dnsSetCalls.at(-1) as { record: { name: string; value: string } } | undefined;
        return lastSet && lastSet.record.name === name ? [lastSet.record.value] : [];
      },
    });
    deps.dnsDeleteRecord = async () => {
      order.push("delete");
    };

    try {
      await certEnsure(deps, { zone: "example.tld", names: ["example.tld"], certName: "primary" });
    } catch {
      order.push("threw");
    }

    expect(order).toEqual(["delete", "threw"]); // delete happened strictly before the catch observed the throw
  });

  it("throws when no dns-01 challenge is offered for an identifier", async () => {
    const noDns01Http: AcmeHttpFn = async (method, url, body) => {
      if (url === "https://acme.test/authz/1") {
        return json(200, { identifier: { type: "dns", value: "example.tld" }, status: "pending", challenges: [{ type: "http-01", url: "x", token: "y", status: "pending" }] }, "n");
      }
      return fakeAcmeServer().http(method, url, body);
    };
    const { deps } = baseDeps({ http: noDns01Http });
    await expect(certEnsure(deps, { zone: "example.tld", names: ["example.tld"], certName: "primary" })).rejects.toThrow(/no dns-01 challenge/);
  });
});

describe("csr.ts sanity (used indirectly by certEnsure's finalize step)", () => {
  it("generateCsr produces a non-empty DER buffer starting with a SEQUENCE tag", () => {
    const { csrDer, keyPair } = generateCsr(generateAccountKey, ["example.tld"]);
    expect(csrDer[0]).toBe(0x30); // SEQUENCE
    expect(csrDer.length).toBeGreaterThan(50);
    expect(keyPair.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });
});
