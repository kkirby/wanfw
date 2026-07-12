import { createHash } from "node:crypto";
import {
  fetchDirectory,
  fetchNonce,
  createAccount,
  createOrder,
  fetchAuthorization,
  respondToChallenge,
  finalizeOrder,
  downloadCertificate,
  pollResource,
  type AcmeHttpFn,
  type AcmeAuthorization,
  type AcmeOrder,
} from "./acme-client.js";
import { generateAccountKey, jwkThumbprint, base64url, type AccountKeyPair } from "./jws.js";
import { generateCsr, type CertificateKeyPair } from "./csr.js";

const ACCOUNT_KEY_SECRET_NAME = "cert-letsencrypt-dns01/acme-account-key";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // §9: propagation poll capped at 10 min; reused as the general authorization/order poll cap

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  ttl?: number;
}

/** Every side-effecting dependency injected -- host API calls (secrets, DNS broker, cert storage), the ACME HTTP transport, DNS propagation checking, and time, so the full flow (including its failure paths) is unit-testable with zero real network or wall-clock waits. */
export interface CertEnsureDeps {
  http: AcmeHttpFn;
  directoryUrl: string;
  secretsGet: (name: string) => Promise<string | null>;
  secretsPut: (name: string, value: string) => Promise<void>;
  dnsSetRecord: (zone: string, record: DnsRecord) => Promise<void>;
  dnsDeleteRecord: (zone: string, record: DnsRecord) => Promise<void>;
  dnsQuery: (name: string, type: string, result: unknown) => Promise<void>;
  certsStore: (name: string, certPem: string, keyPem: string, meta: Record<string, unknown>) => Promise<void>;
  /** Resolves a TXT record via real DNS (authoritative NS first, then public resolvers per §9) -- returns the TXT values seen, or [] if not yet visible. Injected so propagation polling is fully testable without real DNS or real waits. */
  resolveTxt: (name: string) => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
  generateAccountKeyPair?: () => AccountKeyPair;
  generateCertKeyPair?: () => CertificateKeyPair;
  now?: () => number;
}

export interface CertEnsureInput {
  zone: string; // the registrable DNS zone the DNS-01 TXT record is published under (e.g. "example.tld")
  names: string[]; // ACME identifiers, e.g. ["example.tld", "*.example.tld"]
  certName: string; // storage key for certs.store, e.g. "wildcard"
}

export type CertEnsureOutput = Record<string, never>;

async function loadOrCreateAccountKey(deps: CertEnsureDeps): Promise<AccountKeyPair> {
  const existing = await deps.secretsGet(ACCOUNT_KEY_SECRET_NAME);
  if (existing) return JSON.parse(existing) as AccountKeyPair;
  const generated = (deps.generateAccountKeyPair ?? generateAccountKey)();
  await deps.secretsPut(ACCOUNT_KEY_SECRET_NAME, JSON.stringify(generated));
  return generated;
}

function dns01TxtValue(token: string, thumbprint: string): string {
  const keyAuthorization = `${token}.${thumbprint}`;
  return base64url(createHash("sha256").update(keyAuthorization, "utf8").digest());
}

function txtRecordNameFor(identifier: string): string {
  // "*.example.tld" and "example.tld" both challenge under the same
  // "_acme-challenge.example.tld" name (RFC 8555 §8.4) -- strip the
  // wildcard label before prefixing, never double it.
  const base = identifier.startsWith("*.") ? identifier.slice(2) : identifier;
  return `_acme-challenge.${base}`;
}

async function waitForPropagation(deps: CertEnsureDeps, recordName: string, expectedValue: string): Promise<void> {
  const now = deps.now ?? Date.now;
  const deadline = now() + POLL_TIMEOUT_MS;
  while (now() < deadline) {
    const values = await deps.resolveTxt(recordName);
    void deps.dnsQuery(recordName, "TXT", values); // advisory logging only, per §6.6
    if (values.includes(expectedValue)) return;
    await deps.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`DNS-01 TXT record for '${recordName}' never propagated within ${POLL_TIMEOUT_MS}ms`);
}

async function pollUntilDone<T extends { status: string }>(
  deps: CertEnsureDeps,
  poll: (nonce: string) => Promise<{ resource: T; nextNonce: string }>,
  nonce: string,
  doneStatuses: string[],
): Promise<{ resource: T; nextNonce: string }> {
  const now = deps.now ?? Date.now;
  const deadline = now() + POLL_TIMEOUT_MS;
  let currentNonce = nonce;
  while (now() < deadline) {
    const { resource, nextNonce } = await poll(currentNonce);
    currentNonce = nextNonce;
    if (doneStatuses.includes(resource.status)) return { resource, nextNonce: currentNonce };
    if (resource.status === "invalid") return { resource, nextNonce: currentNonce };
    await deps.sleep(POLL_INTERVAL_MS);
  }
  throw new Error("polling timed out before reaching a terminal status");
}

/**
 * `cert.ensure(names)` (§9): the full DNS-01 issue flow. Per-authorization
 * cleanup is the load-bearing property here (T4.4's own "Done when"):
 * once `dns.setRecord` has published the TXT challenge, `dns.deleteRecord`
 * is *always* attempted before this function returns or throws --
 * `try/finally`, not a happy-path-only cleanup call -- covering ACME
 * validation failures, DNS propagation timeouts, and any unexpected
 * exception alike.
 */
export async function certEnsure(deps: CertEnsureDeps, input: CertEnsureInput): Promise<CertEnsureOutput> {
  const accountKey = await loadOrCreateAccountKey(deps);
  const dir = await fetchDirectory(deps.http, deps.directoryUrl);
  let nonce = await fetchNonce(deps.http, dir.newNonce);

  const account = await createAccount(deps.http, dir, accountKey, nonce);
  nonce = account.nextNonce;

  const order = await createOrder(deps.http, dir, accountKey, account.accountUrl, nonce, input.names);
  nonce = order.nextNonce;

  const thumbprint = jwkThumbprint(accountKey.publicKeyPem);

  for (const authUrl of order.order.authorizations) {
    const fetched = await fetchAuthorization(deps.http, accountKey, account.accountUrl, nonce, authUrl);
    nonce = fetched.nextNonce;
    const authorization: AcmeAuthorization = fetched.authorization;

    // RFC 8555 §7.1.4: a server MAY reuse an existing valid authorization
    // for an identifier instead of issuing a fresh pending one -- both
    // Pebble (its own boot log: "attempt authz reuse for each identifier
    // 50% of the time") and real production Let's Encrypt do this. An
    // already-valid authorization's challenges are no longer in "pending"
    // state, so POSTing a challenge response against one is a protocol
    // violation the server is entitled to reject; skip straight past this
    // authorization (no TXT record needed at all) rather than always
    // attempting to complete it. Found live (T4.7): without this check,
    // a renewal request for an already-authorized name silently failed
    // every time Pebble happened to reuse the prior authorization.
    if (authorization.status === "valid") continue;

    const challenge = authorization.challenges.find((c) => c.type === "dns-01");
    if (!challenge) throw new Error(`no dns-01 challenge offered for '${authorization.identifier.value}'`);

    const recordName = txtRecordNameFor(authorization.identifier.value);
    const txtValue = dns01TxtValue(challenge.token, thumbprint);
    const record: DnsRecord = { type: "TXT", name: recordName, value: txtValue, ttl: 60 };

    await deps.dnsSetRecord(input.zone, record);
    try {
      await waitForPropagation(deps, recordName, txtValue);

      const responded = await respondToChallenge(deps.http, accountKey, account.accountUrl, nonce, challenge.url);
      nonce = responded.nextNonce;

      const polled = await pollUntilDone<AcmeAuthorization>(
        deps,
        (n) => pollResource<AcmeAuthorization>(deps.http, accountKey, account.accountUrl, n, authUrl),
        nonce,
        ["valid"],
      );
      nonce = polled.nextNonce;
      if (polled.resource.status !== "valid") {
        throw new Error(`authorization for '${authorization.identifier.value}' did not validate (status: ${polled.resource.status})`);
      }
    } finally {
      // Always attempted, including on every failure path above -- the
      // exact property T4.4's "Done when" requires be tested explicitly.
      await deps.dnsDeleteRecord(input.zone, record);
    }
  }

  const { csrDer, keyPair } = generateCsr(deps.generateCertKeyPair ?? defaultCertKeyPair, input.names);
  const finalized = await finalizeOrder(deps.http, accountKey, account.accountUrl, nonce, order.order.finalize, csrDer);
  nonce = finalized.nextNonce;

  const polledOrder = await pollUntilDone<AcmeOrder>(
    deps,
    (n) => pollResource<AcmeOrder>(deps.http, accountKey, account.accountUrl, n, order.orderUrl),
    nonce,
    ["valid"],
  );
  nonce = polledOrder.nextNonce;
  if (polledOrder.resource.status !== "valid" || !polledOrder.resource.certificate) {
    throw new Error(`order did not finalize to a valid certificate (status: ${polledOrder.resource.status})`);
  }

  const downloaded = await downloadCertificate(deps.http, accountKey, account.accountUrl, nonce, polledOrder.resource.certificate);
  await deps.certsStore(input.certName, downloaded.certPem, keyPair.privateKeyPem, { names: input.names });

  return {};
}

function defaultCertKeyPair(): CertificateKeyPair {
  return generateAccountKey(); // same EC P-256 shape; separate call site keeps intent (account key vs. cert key) explicit at each call
}
