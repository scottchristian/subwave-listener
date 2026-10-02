// Reachability of a station address, as seen by the people listening.
//
// Kept out of the component so it can be read in one place: the wizard's job here is
// to catch a station that will work on the operator's own machine and nowhere else,
// and that check is only as good as this function.

/** Loopback, LAN, link-local, CGNAT and multicast/reserved, for one IPv4 quad. */
export function isPrivateV4(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true; // loopback, 10/8, unspecified
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, RFC 6598
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Can a listener on the public internet reach this address?
 *
 * The player is a client component. Every listener's own browser fetches the
 * SUB/WAVE host directly for now-playing, the schedule and cover art, so this
 * address is consumed by other people's devices rather than by this server. A
 * loopback, LAN or overlay address parses perfectly, is a perfectly working
 * station, and is unreachable to everyone except the operator — which shows up
 * later as a silent player rather than as an error anyone can act on.
 *
 * Unparseable input answers false, so the caller shows the address note rather
 * than waving through something it could not understand.
 */
export function addressIsPubliclyReachable(raw: string): boolean {
  let host: string;
  try {
    // URL.hostname keeps IPv6 in brackets, and normalises IPv4-mapped forms
    // (::ffff:127.0.0.1) into two hex groups. Both are handled below.
    host = new URL(raw.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (!host) return false;

  if (host === "localhost") return false;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;

  // IPv6 loopback is written ::1, 0:0:0:0:0:0:0:1, or ::ffff:7f00:1 — none of
  // which a bare "::" test would catch.
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return false;
  if (host === "::") return false;

  // IPv4-mapped and IPv4-compatible reach the same addresses as plain IPv4.
  const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    if (isPrivateV4(hi >> 8, hi & 0xff)) return false;
  }

  // Unique-local fc00::/7 and link-local fe80::/10.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return false;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a > 255 || b > 255) return false;
    if (isPrivateV4(a, b)) return false;
  }

  return true;
}
