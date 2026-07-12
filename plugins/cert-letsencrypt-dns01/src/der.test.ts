import { describe, expect, it } from "vitest";
import { der } from "./der.js";

describe("der (minimal ASN.1 DER encoding primitives)", () => {
  it("encodes a short-form length (< 128) as a single byte", () => {
    const seq = der.sequence(der.integer(1));
    // SEQUENCE tag (0x30), length byte, then the INTEGER TLV (0x02 0x01 0x01)
    expect(seq[0]).toBe(0x30);
    expect(seq[1]).toBe(3); // length of the inner INTEGER TLV
  });

  it("encodes a long-form length (>= 128) with the 0x80|n-bytes prefix", () => {
    const bigContent = Buffer.alloc(200, 0xaa);
    const octetString = der.octetString(bigContent);
    expect(octetString[0]).toBe(0x04); // OCTET STRING tag
    expect(octetString[1]).toBe(0x81); // long form, 1 length byte follows
    expect(octetString[2]).toBe(200);
  });

  it("oid encodes the well-known extensionRequest OID with the standard first-byte combination rule (40*X+Y)", () => {
    // 1.2.840.113549.1.9.14 -- first two arcs (1, 2) combine to 40*1+2 = 42 = 0x2a
    const oid = der.oid("1.2.840.113549.1.9.14");
    expect(oid[0]).toBe(0x06); // OBJECT IDENTIFIER tag
    expect(oid[2]).toBe(0x2a);
  });

  it("bitString prepends the unused-bits count byte", () => {
    const bs = der.bitString(Buffer.from([0xff, 0xff]), 0);
    expect(bs[0]).toBe(0x03); // BIT STRING tag
    expect(bs[2]).toBe(0x00); // unused bits count
  });

  it("contextPrimitive tags with the context-specific primitive class (0x80 | tagNumber)", () => {
    const dnsName = der.contextPrimitive(2, Buffer.from("example.tld", "ascii"));
    expect(dnsName[0]).toBe(0x82); // [2] IMPLICIT primitive
  });
});
