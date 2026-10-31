/**
 * Who counts as a board's maker for the free creations rule
 * (PIN-205, docs/15 "Free creations rule"): the signed-in user
 * when there is one, else the client address. IPv4 is used as is
 * (IPv4-mapped IPv6 unwrapped); IPv6 is cut to its /64, the block
 * one household or phone usually holds, so rotating addresses
 * inside it does not mint new makers. Anything unparseable shares
 * one bucket. The result is hashed with a versioned prefix, so a
 * raw IP or user id never reaches storage (the PIN-90/91 practice).
 */
import { isIPv4, isIPv6 } from "node:net";
import { hashToken } from "./tokens";

export interface MakerIdentity {
  /** Signed-in user id (AUTH_MODE=optional only); absent = signed out. */
  userId?: string | null;
  /** Client address from the rate-limit helper (may be "unknown"). */
  clientIp?: string | null;
}

/** Strip a port, brackets and an IPv6 zone id from one address entry. */
function bareAddress(raw: string): string {
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1];
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  if (v4WithPort) value = v4WithPort[1];
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  return value.toLowerCase();
}

/** Expand a valid IPv6 address to its 8 hextets (embedded IPv4 tail included). */
function ipv6Hextets(address: string): string[] {
  let text = address;
  const v4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4Tail) {
    const [a, b, c, d] = v4Tail[1].split(".").map(Number);
    text = `${text.slice(0, v4Tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const fill = tail === null ? [] : Array(8 - headParts.length - tailParts.length).fill("0");
  return [...headParts, ...fill, ...tailParts].map((part) => part.padStart(4, "0"));
}

/** The unhashed maker source: `uid:…`, `ip4:…`, `ip6:<first 64 bits>` or `ip:other`. */
export function makerSource(identity: MakerIdentity): string {
  const userId = identity.userId?.trim();
  if (userId) return `uid:${userId}`;
  const address = bareAddress(identity.clientIp ?? "");
  if (isIPv4(address)) return `ip4:${address}`;
  if (isIPv6(address)) {
    const hextets = ipv6Hextets(address);
    // ::ffff:a.b.c.d is an IPv4 client seen through a dual stack.
    if (hextets.slice(0, 5).every((h) => h === "0000") && hextets[5] === "ffff") {
      const n = (parseInt(hextets[6], 16) << 16) | parseInt(hextets[7], 16);
      return `ip4:${[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")}`;
    }
    return `ip6:${hextets.slice(0, 4).join(":")}`;
  }
  return "ip:other";
}

/** Opaque store key for the maker (sha256 hex; never the raw source). */
export function makerKey(identity: MakerIdentity): string {
  return hashToken(`pinned-maker:v1:${makerSource(identity)}`);
}
