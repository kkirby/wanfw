import { createSign, createHash, generateKeyPairSync, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

/**
 * Minimal ACME-flavored JWS (RFC 7515 subset + RFC 8555 §6.2), ES256 only
 * (P-256 + SHA-256) -- the modern, universally-supported ACME account key
 * algorithm; no RSA support needed for v1. Hand-rolled rather than a JOSE
 * library dependency: ACME's JWS usage is narrow (exactly one alg, exactly
 * two header shapes -- `jwk` for the very first request, `kid` for every
 * request after account creation), and shipped plugin bundles carry no
 * node_modules (T3.10's constraint), so a dependency would need bundling
 * anyway.
 */

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface AccountKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Generates a fresh P-256 ACME account key pair (§9: "account key created on first run"). */
export function generateAccountKey(): AccountKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

function jwkFromPublicKey(publicKey: KeyObject): { kty: "EC"; crv: "P-256"; x: string; y: string } {
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** RFC 7638 JWK thumbprint -- used as the DNS-01 key authorization suffix. */
export function jwkThumbprint(publicKeyPem: string): string {
  const publicKey = createPublicKey(publicKeyPem);
  const jwk = jwkFromPublicKey(publicKey);
  // RFC 7638 requires lexicographic key order and no whitespace, exactly this shape for an EC key.
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return base64url(createHash("sha256").update(canonical, "utf8").digest());
}

export interface SignJwsOptions {
  privateKeyPem: string;
  payload: unknown;
  url: string;
  nonce: string;
  /** Present only for the very first request (newAccount); every later request uses `kid` instead. */
  jwkPublicKeyPem?: string;
  kid?: string;
}

/** Signs an ACME-flavored flattened JWS: {protected, payload, signature}, all base64url. */
export function signJws(options: SignJwsOptions): { protected: string; payload: string; signature: string } {
  const privateKey = createPrivateKey(options.privateKeyPem);
  const header: Record<string, unknown> = { alg: "ES256", nonce: options.nonce, url: options.url };
  if (options.kid) {
    header.kid = options.kid;
  } else if (options.jwkPublicKeyPem) {
    header.jwk = jwkFromPublicKey(createPublicKey(options.jwkPublicKeyPem));
  } else {
    throw new Error("signJws requires either kid or jwkPublicKeyPem");
  }

  const protectedB64 = base64url(Buffer.from(JSON.stringify(header), "utf8"));
  // POST-as-GET requests (e.g. polling) use an empty string payload, not "{}".
  const payloadB64 = options.payload === "" ? "" : base64url(Buffer.from(JSON.stringify(options.payload), "utf8"));
  const signingInput = `${protectedB64}.${payloadB64}`;

  // node:crypto's ES256 signature is DER-encoded by default; JOSE requires
  // the raw fixed-width r||s concatenation (64 bytes for P-256) instead.
  const derSig = createSign("SHA256").update(signingInput).sign(privateKey);
  const rawSig = derToRawEcdsaSignature(derSig, 32);

  return { protected: protectedB64, payload: payloadB64, signature: base64url(rawSig) };
}

/** Converts a DER-encoded ECDSA signature to JOSE's raw r||s concatenation (RFC 7518 §3.4). */
function derToRawEcdsaSignature(der: Buffer, componentLength: number): Buffer {
  // SEQUENCE { INTEGER r, INTEGER s } -- strip leading 0x00 padding bytes
  // (added when the integer's high bit is set) down to exactly componentLength.
  let offset = 2; // skip SEQUENCE tag + length byte
  function readInt(): Buffer {
    if (der[offset] !== 0x02) throw new Error("expected INTEGER in DER ECDSA signature");
    offset++;
    let len = der[offset]!;
    offset++;
    let bytes = der.subarray(offset, offset + len);
    offset += len;
    while (bytes.length > componentLength && bytes[0] === 0x00) bytes = bytes.subarray(1);
    if (bytes.length < componentLength) {
      const padded = Buffer.alloc(componentLength);
      bytes.copy(padded, componentLength - bytes.length);
      bytes = padded;
    }
    return bytes;
  }
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

export { base64url };
