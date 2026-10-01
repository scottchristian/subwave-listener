#!/usr/bin/env node
// Stop deployment-specific detail from being committed into the documentation.
//
// This exists because it already happened: a design note went into docs/ with
// the author's real server address, a private-network IP and their station's
// hostname in it. The repo is public, so that was published.
//
// The rules below are deliberately GENERIC — none of them hardcode a hostname,
// a station name or an address, because writing one in to detect it would
// republish exactly the thing being removed. They catch the shapes instead:
// an address that is not a documentation example, and an ssh target that is
// not a placeholder.
//
// Checks: `npm run check:refs` (also part of `npm run check`).
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const DOC = /\.(md|mdx)$/i;

// Hosts that are obviously placeholders. Anything else with a dot in it is
// treated as a real name.
const PLACEHOLDER_HOSTS = new Set([
  "example.com",
  "www.example.com",
  "example.org",
  "example.net",
  "localhost",
  "your-host",
  "your-host.example.com",
  "host.example.com",
]);

// RFC 5737 "TEST-NET" ranges. These are the addresses documentation is
// *supposed* to use; anything else routable is assumed real.
const EXAMPLE_V4 = /^(192\.0\.2|198\.51\.100|203\.0\.113)\./;

const V4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

function classifyV4(octets) {
  const [a, b] = octets;
  if (a === 127) return "loopback";
  if (a === 0) return "unspecified";
  if (a === 169 && b === 254) return "link-local";
  if (a >= 224 && a <= 239) return "multicast";
  // RFC 6598 / Tailscale: carrier-grade NAT shared address space.
  if (a === 100 && b >= 64 && b <= 127) return "cgnat/private-overlay";
  if (a === 10) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  return "public";
}

const RULES = [
  {
    id: "private-address-in-docs",
    // A private, loopback, link-local or overlay address in documentation is
    // almost always copied off a real machine. Documentation has no use for
    // one: there is nothing to connect to.
    test: (line) => {
      const hits = [];
      for (const m of line.matchAll(V4)) {
        // m[0] is the whole address; m[1] is only the first octet.
        const o = m[0].split(".").map(Number);
        if (o.some((n) => n > 255)) continue;
        const kind = classifyV4(o);
        if (kind === "private" || kind === "cgnat/private-overlay") {
          hits.push(`${m[0]} (${kind})`);
        }
      }
      return hits;
    },
    why: "documents a real private or overlay address. Use a documentation range (192.0.2.x, 198.51.100.x, 203.0.113.x) or write it as a placeholder.",
  },
  {
    id: "public-address-in-docs",
    test: (line) => {
      const hits = [];
      for (const m of line.matchAll(V4)) {
        // m[0] is the whole address; m[1] is only the first octet.
        const o = m[0].split(".").map(Number);
        if (o.some((n) => n > 255)) continue;
        if (classifyV4(o) !== "public") continue;
        if (EXAMPLE_V4.test(m[0])) continue;
        hits.push(`${m[0]} (public)`);
      }
      return hits;
    },
    why: "documents a globally routable address. Use a documentation range, or describe the host without naming it.",
  },
  {
    id: "real-ssh-target-in-docs",
    test: (line) => {
      const hits = [];
      for (const m of line.matchAll(/\bssh\s+(?:-\S+\s+)*([a-z_][\w.-]*)@([\w.-]+)/g)) {
        const host = m[2].toLowerCase();
        if (!host.includes(".")) continue; // bare hostname on a private network
        if (PLACEHOLDER_HOSTS.has(host)) continue;
        if (host.endsWith(".example.com") || host.endsWith(".example.org")) continue;
        if (host.endsWith(".invalid")) continue; // RFC 2606 reserved
        hits.push(`${m[1]}@${m[2]}`);
      }
      return hits;
    },
    why: "names a real ssh target. Use HOST/APP_DIR variables or an example.com placeholder.",
  },
];

function tracked() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

const problems = [];
for (const file of tracked()) {
  if (!DOC.test(file)) continue;
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      const hits = rule.test(line);
      for (const h of hits) {
        problems.push({ file, line: i + 1, rule: rule.id, hit: h, why: rule.why });
      }
    }
  });
}

if (problems.length === 0) {
  console.log("check:refs — no deployment-specific detail in the documentation.");
  process.exit(0);
}

console.error(`check:refs — ${problems.length} problem(s) in the documentation:\n`);
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  [${p.rule}]  ${p.hit}`);
  console.error(`      ${p.why}\n`);
}
console.error(
  "These are deployment details, not documentation. A public repository publishes\n" +
    "them to everyone, including anyone who finds the URL later. Replace with a\n" +
    "placeholder, or move the detail into a gitignored runbook of your own.",
);
process.exit(1);
