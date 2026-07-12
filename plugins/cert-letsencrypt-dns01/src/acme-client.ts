import { signJws, base64url, type AccountKeyPair } from "./jws.js";

/**
 * Minimal ACME v2 (RFC 8555) client -- exactly the subset the DNS-01 issue
 * flow needs (account creation, order, authorization, challenge response,
 * finalize, download), nothing else (no HTTP-01/TLS-ALPN-01, no account
 * key rollover, no order revocation). Every function threads the ACME
 * nonce explicitly in and out (`nextNonce` on the return value) rather
 * than hiding it in module state, since ACME requires a fresh nonce per
 * request and the caller (`cert-ensure.ts`) needs to sequence many of
 * these across real network round trips and DNS propagation waits.
 */

export interface AcmeHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Injected transport, not `fetch()`: real plugin runtime uses `node:https` directly (T4.2's WASM/`prlimit --as` lesson applies here too), tests inject a fake. */
export type AcmeHttpFn = (method: "GET" | "HEAD" | "POST", url: string, body?: string) => Promise<AcmeHttpResponse>;

export interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

function nonceOf(res: AcmeHttpResponse): string {
  const nonce = res.headers["replay-nonce"];
  if (!nonce) throw new Error("ACME response missing Replay-Nonce header");
  return nonce;
}

function parseAcmeError(res: AcmeHttpResponse): never {
  let detail = res.body;
  try {
    const parsed = JSON.parse(res.body) as { type?: string; detail?: string };
    detail = parsed.detail ?? parsed.type ?? res.body;
  } catch {
    // non-JSON error body; use as-is
  }
  throw new Error(`ACME server error (HTTP ${res.status}): ${detail}`);
}

export async function fetchDirectory(http: AcmeHttpFn, directoryUrl: string): Promise<AcmeDirectory> {
  const res = await http("GET", directoryUrl);
  if (res.status >= 400) parseAcmeError(res);
  return JSON.parse(res.body) as AcmeDirectory;
}

export async function fetchNonce(http: AcmeHttpFn, newNonceUrl: string): Promise<string> {
  const res = await http("HEAD", newNonceUrl);
  return nonceOf(res);
}

async function signedPost(
  http: AcmeHttpFn,
  url: string,
  accountKey: AccountKeyPair,
  nonce: string,
  payload: unknown,
  kid?: string,
): Promise<{ res: AcmeHttpResponse; nextNonce: string }> {
  const jws = signJws({
    privateKeyPem: accountKey.privateKeyPem,
    payload,
    url,
    nonce,
    kid,
    jwkPublicKeyPem: kid ? undefined : accountKey.publicKeyPem,
  });
  const res = await http("POST", url, JSON.stringify(jws));
  return { res, nextNonce: nonceOf(res) };
}

export interface CreateAccountResult {
  accountUrl: string;
  nextNonce: string;
}

/** newAccount (§9: "ACME account created on first run"). */
export async function createAccount(
  http: AcmeHttpFn,
  dir: AcmeDirectory,
  accountKey: AccountKeyPair,
  nonce: string,
): Promise<CreateAccountResult> {
  const { res, nextNonce } = await signedPost(http, dir.newAccount, accountKey, nonce, { termsOfServiceAgreed: true });
  if (res.status >= 400) parseAcmeError(res);
  const accountUrl = res.headers.location;
  if (!accountUrl) throw new Error("newAccount response missing Location header");
  return { accountUrl, nextNonce };
}

export interface AcmeOrder {
  status: string;
  authorizations: string[];
  finalize: string;
  certificate?: string;
}

export interface CreateOrderResult {
  orderUrl: string;
  order: AcmeOrder;
  nextNonce: string;
}

export async function createOrder(
  http: AcmeHttpFn,
  dir: AcmeDirectory,
  accountKey: AccountKeyPair,
  kid: string,
  nonce: string,
  names: string[],
): Promise<CreateOrderResult> {
  const { res, nextNonce } = await signedPost(
    http,
    dir.newOrder,
    accountKey,
    nonce,
    { identifiers: names.map((value) => ({ type: "dns", value })) },
    kid,
  );
  if (res.status >= 400) parseAcmeError(res);
  const orderUrl = res.headers.location;
  if (!orderUrl) throw new Error("newOrder response missing Location header");
  return { orderUrl, order: JSON.parse(res.body) as AcmeOrder, nextNonce };
}

export interface AcmeChallenge {
  type: string;
  url: string;
  token: string;
  status: string;
}

export interface AcmeAuthorization {
  identifier: { type: string; value: string };
  status: string;
  challenges: AcmeChallenge[];
}

/** POST-as-GET (empty payload -- a plain GET is not valid for ACME resource fetches per RFC 8555 §6.3). */
async function postAsGet(http: AcmeHttpFn, url: string, accountKey: AccountKeyPair, kid: string, nonce: string): Promise<{ res: AcmeHttpResponse; nextNonce: string }> {
  return signedPost(http, url, accountKey, nonce, "", kid);
}

export async function fetchAuthorization(
  http: AcmeHttpFn,
  accountKey: AccountKeyPair,
  kid: string,
  nonce: string,
  authUrl: string,
): Promise<{ authorization: AcmeAuthorization; nextNonce: string }> {
  const { res, nextNonce } = await postAsGet(http, authUrl, accountKey, kid, nonce);
  if (res.status >= 400) parseAcmeError(res);
  return { authorization: JSON.parse(res.body) as AcmeAuthorization, nextNonce };
}

/** Tells the ACME server "the challenge is ready to validate" (RFC 8555 §7.5.1). */
export async function respondToChallenge(
  http: AcmeHttpFn,
  accountKey: AccountKeyPair,
  kid: string,
  nonce: string,
  challengeUrl: string,
): Promise<{ nextNonce: string }> {
  const { res, nextNonce } = await signedPost(http, challengeUrl, accountKey, nonce, {}, kid);
  if (res.status >= 400) parseAcmeError(res);
  return { nextNonce };
}

export async function finalizeOrder(
  http: AcmeHttpFn,
  accountKey: AccountKeyPair,
  kid: string,
  nonce: string,
  finalizeUrl: string,
  csrDer: Buffer,
): Promise<{ order: AcmeOrder; nextNonce: string }> {
  const { res, nextNonce } = await signedPost(http, finalizeUrl, accountKey, nonce, { csr: base64url(csrDer) }, kid);
  if (res.status >= 400) parseAcmeError(res);
  return { order: JSON.parse(res.body) as AcmeOrder, nextNonce };
}

export async function downloadCertificate(
  http: AcmeHttpFn,
  accountKey: AccountKeyPair,
  kid: string,
  nonce: string,
  certificateUrl: string,
): Promise<{ certPem: string; nextNonce: string }> {
  const { res, nextNonce } = await postAsGet(http, certificateUrl, accountKey, kid, nonce);
  if (res.status >= 400) parseAcmeError(res);
  return { certPem: res.body, nextNonce };
}

/** Re-fetches an order or authorization resource by POST-as-GET, for status polling. */
export async function pollResource<T>(
  http: AcmeHttpFn,
  accountKey: AccountKeyPair,
  kid: string,
  nonce: string,
  url: string,
): Promise<{ resource: T; nextNonce: string }> {
  const { res, nextNonce } = await postAsGet(http, url, accountKey, kid, nonce);
  if (res.status >= 400) parseAcmeError(res);
  return { resource: JSON.parse(res.body) as T, nextNonce };
}
