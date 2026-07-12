import { describe, expect, it } from "vitest";
import { createVerify, createPublicKey } from "node:crypto";
import { generateAccountKey, signJws, jwkThumbprint, base64url } from "./jws.js";

function fromB64Url(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function toDerEcdsaSignature(rawSig: Buffer): Buffer {
  // Inverse of jws.ts's derToRawEcdsaSignature, for test-side verification with node:crypto's DER-expecting createVerify.
  const r = rawSig.subarray(0, 32);
  const s = rawSig.subarray(32, 64);
  function toDerInt(component: Buffer): Buffer {
    let b = component;
    while (b.length > 1 && b[0] === 0x00 && (b[1]! & 0x80) === 0) b = b.subarray(1);
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  }
  const derR = toDerInt(r);
  const derS = toDerInt(s);
  const body = Buffer.concat([derR, derS]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

describe("jws (ACME-flavored ES256 JWS)", () => {
  it("generateAccountKey produces a usable P-256 PEM key pair", () => {
    const keyPair = generateAccountKey();
    expect(keyPair.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(keyPair.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("signJws with jwk (first request) produces a header containing jwk, alg, nonce, url -- and no kid", () => {
    const keyPair = generateAccountKey();
    const jws = signJws({ privateKeyPem: keyPair.privateKeyPem, payload: { hello: "world" }, url: "https://acme.test/new-account", nonce: "n1", jwkPublicKeyPem: keyPair.publicKeyPem });
    const header = JSON.parse(fromB64Url(jws.protected).toString("utf8"));
    expect(header.alg).toBe("ES256");
    expect(header.nonce).toBe("n1");
    expect(header.url).toBe("https://acme.test/new-account");
    expect(header.jwk).toBeDefined();
    expect(header.jwk.kty).toBe("EC");
    expect(header.kid).toBeUndefined();
  });

  it("signJws with kid (every request after account creation) omits jwk", () => {
    const keyPair = generateAccountKey();
    const jws = signJws({ privateKeyPem: keyPair.privateKeyPem, payload: {}, url: "https://acme.test/order/1", nonce: "n2", kid: "https://acme.test/acct/1" });
    const header = JSON.parse(fromB64Url(jws.protected).toString("utf8"));
    expect(header.kid).toBe("https://acme.test/acct/1");
    expect(header.jwk).toBeUndefined();
  });

  it("an empty-string payload (POST-as-GET) produces an empty payload segment, not the base64 of \"\"\"\"", () => {
    const keyPair = generateAccountKey();
    const jws = signJws({ privateKeyPem: keyPair.privateKeyPem, payload: "", url: "https://acme.test/order/1", nonce: "n3", kid: "https://acme.test/acct/1" });
    expect(jws.payload).toBe("");
  });

  it("produces a signature that verifies against the account public key (proves the DER->raw r||s conversion is correct)", () => {
    const keyPair = generateAccountKey();
    const jws = signJws({ privateKeyPem: keyPair.privateKeyPem, payload: { a: 1 }, url: "https://acme.test/x", nonce: "n4", jwkPublicKeyPem: keyPair.publicKeyPem });
    const signingInput = `${jws.protected}.${jws.payload}`;
    const rawSig = fromB64Url(jws.signature);
    const derSig = toDerEcdsaSignature(rawSig);
    const verifier = createVerify("SHA256");
    verifier.update(signingInput);
    const ok = verifier.verify(createPublicKey(keyPair.publicKeyPem), derSig);
    expect(ok).toBe(true);
  });

  it("jwkThumbprint is deterministic for the same key and differs across keys", () => {
    const keyPair = generateAccountKey();
    const t1 = jwkThumbprint(keyPair.publicKeyPem);
    const t2 = jwkThumbprint(keyPair.publicKeyPem);
    expect(t1).toBe(t2);

    const otherKeyPair = generateAccountKey();
    expect(jwkThumbprint(otherKeyPair.publicKeyPem)).not.toBe(t1);
  });

  it("base64url produces no padding and URL-safe characters", () => {
    const encoded = base64url(Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]));
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });
});
