/**
 * Minimal IPv4 CIDR math (T5.1) -- just enough for a macvlan reserved-range
 * slice (§8.4: "a reserved CIDR slice outside the DHCP pool and the
 * gateway"), never intended for anything larger than a typical LAN /24-ish
 * range. No IPv6: macvlan's only v1 consumer is a LAN-facing static proxy
 * IP, and the brief's own examples are all IPv4.
 */

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`invalid IPv4 address: '${ip}'`);
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export interface ParsedCidr {
  networkInt: number;
  broadcastInt: number;
  prefixLen: number;
}

export function parseCidr(cidr: string): ParsedCidr {
  const [addr, prefixStr] = cidr.split("/", 2);
  if (!addr || !prefixStr) throw new Error(`invalid CIDR: '${cidr}'`);
  const prefixLen = Number(prefixStr);
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    throw new Error(`invalid CIDR prefix length: '${cidr}'`);
  }
  const hostBits = 32 - prefixLen;
  const mask = hostBits === 32 ? 0 : (0xffffffff << hostBits) >>> 0;
  const networkInt = (ipToInt(addr) & mask) >>> 0;
  const broadcastInt = hostBits === 32 ? 0xffffffff : (networkInt | (~mask >>> 0)) >>> 0;
  return { networkInt, broadcastInt, prefixLen };
}

/**
 * Every usable host address in the range, in order, excluding the network
 * address, the broadcast address, and (if given -- always true for a
 * macvlan reserved range) the gateway. A /31 or /32 has no usable hosts
 * under this exclusion and yields an empty array rather than throwing --
 * exhaustion is the caller's problem to report, not this function's.
 */
export function hostsInCidr(cidr: string, exclude?: string): string[] {
  const { networkInt, broadcastInt, prefixLen } = parseCidr(cidr);
  const excludeInt = exclude ? ipToInt(exclude) : undefined;
  const hosts: string[] = [];
  if (prefixLen >= 31) return hosts; // no network/broadcast split to exclude from
  for (let n = networkInt + 1; n < broadcastInt; n++) {
    if (n === excludeInt) continue;
    hosts.push(intToIp(n));
  }
  return hosts;
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const { networkInt, broadcastInt } = parseCidr(cidr);
  const n = ipToInt(ip);
  return n >= networkInt && n <= broadcastInt;
}
