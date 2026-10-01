#!/usr/bin/env node
// Verify every local link and heading anchor in the documentation resolves.
//
// Broken cross-references are the quietest documentation failure there is: the
// page still renders, the reader just gets sent to the top of a page that does
// not contain what they were sent for. There is nothing to notice.
//
// Anchor slugs are generated the way GitHub generates them, which is not quite
// what you would guess: punctuation is dropped rather than replaced, so an em
// dash between two words leaves TWO hyphens, because the spaces either side of
// it each become one. Collapsing that whitespace — the obvious thing to do —
// silently breaks every such link.
//
//   node scripts/check-links.mjs
import fs from "node:fs";
import path from "node:path";

const DOCS = ["README.md", "CONTRIBUTING.md", "docs/deployment.md", "docs/settings.md", "docs/listener-modes.md"];

/** GitHub's heading -> anchor. Note: no whitespace collapsing. */
const slug = (heading) =>
  heading
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");

const anchorsIn = (markdown) => {
  const out = new Set();
  for (const m of markdown.matchAll(/^#{1,6}\s+(.*)$/gm)) out.add(slug(m[1]));
  return out;
};

const problems = [];
let checked = 0;

for (const file of DOCS) {
  if (!fs.existsSync(file)) {
    problems.push(`${file}: listed here but does not exist`);
    continue;
  }
  const src = fs.readFileSync(file, "utf8");

  // Image sources too — a figure that 404s renders as a broken icon.
  for (const m of src.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    checked++;
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) problems.push(`${file}: image not found — ${m[1]}`);
  }

  for (const m of src.matchAll(/(!?\[[^\]]*\])\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = m[2];
    if (/^(https?:|mailto:|#$)/.test(raw)) continue;
    checked++;
    const [rel, anchor] = raw.split("#");
    const target = rel ? path.resolve(path.dirname(file), rel) : path.resolve(file);
    if (rel && !fs.existsSync(target)) {
      problems.push(`${file}: link target not found — ${raw}`);
      continue;
    }
    if (anchor && target.endsWith(".md") && !anchorsIn(fs.readFileSync(target, "utf8")).has(anchor)) {
      problems.push(`${file}: no heading produces the anchor "${anchor}" — ${raw}`);
    }
  }
}

if (problems.length === 0) {
  console.log(`check:links — ${checked} local link(s) and image(s), all resolve.`);
  process.exit(0);
}

console.error(`check:links — ${problems.length} problem(s):\n`);
for (const p of problems) console.error(`  ${p}\n`);
process.exit(1);
