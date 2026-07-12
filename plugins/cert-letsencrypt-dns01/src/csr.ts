import { createSign, createPrivateKey, createPublicKey } from "node:crypto";
import { der } from "./der.js";

/**
 * Builds a minimal self-signed PKCS#10 CSR (RFC 2986) for a fresh
 * (per-issue, ephemeral) EC P-256 key, empty subject, and a
 * subjectAltName extension listing every requested DNS name -- exactly
 * what Let's Encrypt's DNS-01 flow needs, nothing more (no O/OU/CN,
 * ACME/Let's Encrypt ignores subject fields entirely). The certificate's
 * own key pair is intentionally separate from the ACME *account* key
 * (jws.ts) -- conflating the two would mean losing the cert's private key
 * on account-key rotation, an unrelated and much worse failure mode.
 */
export interface CertificateKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

const OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";

function buildSanExtensionValue(names: string[]): Buffer {
  const generalNames = der.sequence(...names.map((n) => der.contextPrimitive(2, Buffer.from(n, "ascii"))));
  return generalNames;
}

function buildCertificationRequestInfo(publicKeyDer: Buffer, names: string[]): Buffer {
  const version = der.integer(0);
  const subject = der.sequence(); // empty Name -- ACME/LE ignore subject entirely
  const subjectPKInfo = publicKeyDer; // already a full SubjectPublicKeyInfo SEQUENCE (Node's spki export)

  const sanExtension = der.sequence(der.oid(OID_SUBJECT_ALT_NAME), der.octetString(buildSanExtensionValue(names)));
  const extensions = der.sequence(sanExtension);
  const extensionRequestAttribute = der.sequence(der.oid(OID_EXTENSION_REQUEST), der.set(extensions));
  const attributes = der.contextConstructed(0, extensionRequestAttribute);

  return der.sequence(version, subject, subjectPKInfo, attributes);
}

/** Generates a fresh certificate key pair + a CSR for `names`, returning both the CSR (DER, base64url-ready) and the private key PEM to pair with the finalized certificate. */
export function generateCsr(generateKeyPair: () => CertificateKeyPair, names: string[]): { csrDer: Buffer; keyPair: CertificateKeyPair } {
  const keyPair = generateKeyPair();
  const publicKeyDer = createPublicKey(keyPair.publicKeyPem).export({ type: "spki", format: "der" });
  const privateKey = createPrivateKey(keyPair.privateKeyPem);

  const certificationRequestInfo = buildCertificationRequestInfo(publicKeyDer, names);
  const signatureAlgorithm = der.sequence(der.oid(OID_ECDSA_WITH_SHA256));
  const signature = createSign("SHA256").update(certificationRequestInfo).sign(privateKey); // DER-encoded, X.509-native format (unlike JWS's raw r||s)

  const csrDer = der.sequence(certificationRequestInfo, signatureAlgorithm, der.bitString(signature));
  return { csrDer, keyPair };
}
