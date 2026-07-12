/**
 * Minimal ASN.1 DER encoding primitives -- exactly the handful of shapes
 * `csr.ts` needs to build a PKCS#10 CertificationRequest (SEQUENCE, SET,
 * OCTET STRING, OBJECT IDENTIFIER, IA5String, BOOLEAN, INTEGER, BIT
 * STRING, and one context-specific IMPLICIT tag for GeneralName's
 * dNSName choice). Not a general ASN.1 library -- CSR generation is the
 * one place in this codebase that needs raw DER at all, and the full
 * X.680/X.690 spec is a much bigger problem than this narrow use poses.
 */

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export const der = {
  sequence: (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items)),
  set: (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items)),
  octetString: (content: Buffer): Buffer => tlv(0x04, content),
  bitString: (content: Buffer, unusedBits = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), content])),
  integer: (n: number): Buffer => tlv(0x02, Buffer.from([n])),
  boolean: (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00])),
  ia5String: (s: string): Buffer => tlv(0x16, Buffer.from(s, "ascii")),
  /** OBJECT IDENTIFIER from dotted notation, e.g. "1.2.840.113549.1.9.14". */
  oid: (dotted: string): Buffer => {
    const parts = dotted.split(".").map(Number);
    const first = parts[0]! * 40 + parts[1]!;
    const bytes: number[] = [first];
    for (const part of parts.slice(2)) {
      if (part < 0x80) {
        bytes.push(part);
      } else {
        const chunk: number[] = [];
        let n = part;
        chunk.unshift(n & 0x7f);
        n >>>= 7;
        while (n > 0) {
          chunk.unshift((n & 0x7f) | 0x80);
          n >>>= 7;
        }
        bytes.push(...chunk);
      }
    }
    return tlv(0x06, Buffer.from(bytes));
  },
  /** [tagNumber] IMPLICIT content, context-specific primitive class (used for GeneralName's dNSName [2] choice). */
  contextPrimitive: (tagNumber: number, content: Buffer): Buffer => tlv(0x80 | tagNumber, content),
  /** [tagNumber] EXPLICIT/constructed context-specific wrapper (used for CertificationRequestInfo's [0] attributes). */
  contextConstructed: (tagNumber: number, ...items: Buffer[]): Buffer => tlv(0xa0 | tagNumber, Buffer.concat(items)),
};
