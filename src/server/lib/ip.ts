import { BlockList, isIP } from "node:net";

/** Builds an allowlist from IPs and CIDRs such as "203.0.113.4,10.0.0.0/8,2001:db8::/32". */
export function buildAllowList(entries: string[]): BlockList | null {
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    const family = isIP(address ?? "");
    if (!address || family === 0) throw new Error(`Invalid IP allowlist entry: ${entry}`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return list;
}

export function normalizeIp(ip: string | undefined): string {
  if (!ip) return "";
  return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

export function isAllowed(list: BlockList | null, ip: string): boolean {
  if (!list) return true;
  const family = isIP(ip);
  if (family === 0) return false;
  return list.check(ip, family === 4 ? "ipv4" : "ipv6");
}
