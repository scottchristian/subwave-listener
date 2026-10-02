// Throwaway: the wizard's "can listeners actually reach this?" check.
// Imports the real module so the test cannot drift from what ships.
import { addressIsPubliclyReachable } from "../lib/addressreach.ts";

type Case = [url: string, expected: boolean, why: string];

const cases: Case[] = [
  // Public — these must be allowed through.
  ["https://radio.example.com", true, "public hostname"],
  ["http://radio.example.com:7700/api", true, "public with port and path"],
  ["https://example.com", true, "public https"],
  ["http://172.32.0.1", true, "just outside 172.16/12"],
  ["http://100.128.0.1", true, "just outside CGNAT"],
  ["http://8.8.8.8", true, "public IPv4"],
  ["http://[2001:db8::1]:7700", true, "IPv6 global"],

  // Private — these play locally and nowhere else.
  ["http://localhost:7700", false, "localhost with port"],
  ["http://localhost", false, "localhost bare"],
  ["http://127.0.0.1:7700", false, "loopback"],
  ["http://127.1.2.3", false, "loopback range"],
  ["http://192.168.1.50:7700", false, "LAN"],
  ["http://10.0.0.5", false, "10/8"],
  ["http://172.16.0.1", false, "172.16/12 low"],
  ["http://172.31.255.254", false, "172.16/12 high"],
  ["http://169.254.1.1", false, "link-local"],
  ["http://100.64.0.1", false, "CGNAT"],
  ["http://0.0.0.0", false, "unspecified"],
  ["http://station.local", false, "mDNS"],
  ["http://db.internal", false, ".internal"],
  ["http://224.0.0.1", false, "multicast"],

  // IPv6 loopback, in the forms URL parsing actually produces.
  ["http://[::1]:7700", false, "IPv6 loopback, bracketed"],
  ["http://[0:0:0:0:0:0:0:1]", false, "expanded IPv6 loopback"],
  ["http://[::ffff:127.0.0.1]", false, "IPv4-mapped loopback, normalised to hex"],
  ["http://[::ffff:192.168.1.1]", false, "IPv4-mapped LAN, normalised to hex"],
  ["http://[::]", false, "IPv6 unspecified"],
  ["http://[fe80::1]", false, "IPv6 link-local"],
  ["http://[fd00::1]", false, "IPv6 unique-local fd"],
  ["http://[fc00::1]", false, "IPv6 unique-local fc"],

  // Unusable input answers false, so the note shows rather than waving it through.
  ["", false, "empty"],
  ["not a url", false, "unparseable"],
  ["radio.example.com", false, "no scheme"],
  ["   ", false, "whitespace"],
];

let failed = 0;
for (const [url, expected, why] of cases) {
  const got = addressIsPubliclyReachable(url);
  if (got !== expected) {
    failed++;
    console.log(`  FAIL  ${JSON.stringify(url)} -> ${got}, wanted ${expected}  (${why})`);
  }
}
console.log(`  ${cases.length - failed}/${cases.length} passed`);
if (failed) process.exit(1);
