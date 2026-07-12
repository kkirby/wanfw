import { describe, expect, it } from "vitest";
import { parseCidr, hostsInCidr, isIpInCidr } from "./cidr.js";

describe("cidr (T5.1)", () => {
  it("parses a /29 into its network/broadcast integers", () => {
    const parsed = parseCidr("192.168.1.240/29");
    expect(parsed.prefixLen).toBe(29);
    // 192.168.1.240/29 covers .240-.247, network .240, broadcast .247
    expect(parsed.networkInt & 0xff).toBe(240);
    expect(parsed.broadcastInt & 0xff).toBe(247);
  });

  it("throws on a malformed CIDR string", () => {
    expect(() => parseCidr("not-a-cidr")).toThrow();
    expect(() => parseCidr("192.168.1.0/33")).toThrow();
    expect(() => parseCidr("192.168.1.999/24")).toThrow();
  });

  it("enumerates every usable host in a /29, excluding network and broadcast", () => {
    const hosts = hostsInCidr("192.168.1.240/29");
    expect(hosts).toEqual(["192.168.1.241", "192.168.1.242", "192.168.1.243", "192.168.1.244", "192.168.1.245", "192.168.1.246"]);
  });

  it("excludes the gateway address in addition to network/broadcast", () => {
    const hosts = hostsInCidr("192.168.1.240/29", "192.168.1.241");
    expect(hosts).toEqual(["192.168.1.242", "192.168.1.243", "192.168.1.244", "192.168.1.245", "192.168.1.246"]);
  });

  it("a /31 and /32 have zero usable hosts under network/broadcast exclusion", () => {
    expect(hostsInCidr("10.0.0.0/31")).toEqual([]);
    expect(hostsInCidr("10.0.0.0/32")).toEqual([]);
  });

  it("isIpInCidr is true for addresses within the range, including network/broadcast, false outside it", () => {
    expect(isIpInCidr("192.168.1.240", "192.168.1.240/29")).toBe(true);
    expect(isIpInCidr("192.168.1.243", "192.168.1.240/29")).toBe(true);
    expect(isIpInCidr("192.168.1.247", "192.168.1.240/29")).toBe(true);
    expect(isIpInCidr("192.168.1.248", "192.168.1.240/29")).toBe(false);
    expect(isIpInCidr("192.168.2.241", "192.168.1.240/29")).toBe(false);
  });
});
