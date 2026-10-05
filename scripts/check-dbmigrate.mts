// The database cutover's verification helpers.
//
// A cutover copies every table to the other engine and then compares them. Two
// failure modes matter and neither is loud:
//
//   - hash() disagreeing between engines would report a perfect copy as broken
//     (or worse, agree on two different copies), so its stability across a
//     Postgres round trip and a SQLite one is the whole property
//   - a model missing from MODEL_ORDER is copied silently incompletely, and the
//     verification then reports the rows it did copy as a match. That is the
//     worst shape of bug here: it looks like success.
//
// So MODEL_ORDER is checked against the schema itself, not against a list.
//
// Run: npm run check-dbmigrate  (npm run check:db-migrate)
import { readFileSync } from "node:fs";
import path from "node:path";

const dm = await import("../lib/dbmigrate.ts");

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

// ---- hash: identical rows hash identically, always ----
ok(dm.hash([{ a: 1 }]) === dm.hash([{ a: 1 }]), "the same rows hash the same");
ok(dm.hash([]) === dm.hash([]), "two empty sets agree");
ok(dm.hash([{ a: 1 }]) !== dm.hash([{ a: 2 }]), "a changed value changes the hash");
ok(dm.hash([{ a: 1 }]) !== dm.hash([{ a: 1, b: 2 }]), "an added column changes the hash");
ok(dm.hash([{ a: 1 }]) !== dm.hash([{ a: "1" }]), "a type change changes the hash");
ok(dm.hash([{ a: 1 }]) !== dm.hash([{ b: 1 }]), "a renamed column changes the hash");
ok(dm.hash([{ a: null }]) !== dm.hash([{ a: "" }]), "null and empty string differ");

// The cross-engine case that motivates the normaliser: Postgres hands back a
// Date object, SQLite a string, and the same row must hash the same either way.
ok(dm.hash([{ at: new Date("2026-01-02T03:04:05.000Z") }]) === dm.hash([{ at: "2026-01-02T03:04:05.000Z" }]),
  "a Date and its ISO string hash the same — Postgres and SQLite can agree");
ok(dm.hash([{ at: new Date("2026-01-02T03:04:05.000Z") }]) !== dm.hash([{ at: new Date("2026-01-02T03:04:06.000Z") }]),
  "different instants still differ");
ok(/^[0-9a-f]{64}$/.test(dm.hash([{ a: 1 }])), "the hash is a sha256 hex digest");

// sorted: verification compares row sets, so order must not matter.
{
  const rows = [{ id: "b" }, { id: "a" }, { id: "c" }];
  ok(JSON.stringify(dm.sorted(rows)) === JSON.stringify(dm.sorted([...rows].reverse())), "sorting is order-independent");
  ok(dm.sorted(rows)[0].id === "a", "rows are sorted by their first key");
  ok(JSON.stringify(dm.sorted([])) === "[]", "an empty set sorts to empty");
  // Two engines may serialise keys in a different order for the same row.
  // Key order within a row is NOT normalised: findMany() returns columns in
  // schema order, which both engines agree on, so this is a documented property
  // rather than a normalisation. Asserted so a future refactor that *does* start
  // varying column order fails here instead of reporting every cutover as broken.
  ok(dm.hash([{ a: 1, b: 2 }]) !== dm.hash([{ b: 2, a: 1 }]), "column order is significant, as findMany guarantees it");
}

// ---- clientDirFor: one generated client per engine, kept apart ----
ok(dm.clientDirFor("sqlite") !== dm.clientDirFor("postgresql"), "the two engines get different client directories");
for (const p of ["sqlite", "postgresql"] as const) {
  ok(dm.clientDirFor(p).endsWith(p), `the ${p} client lives in its own directory`);
  ok(path.isAbsolute(dm.clientDirFor(p)), `the ${p} client path is absolute`);
}

// ---- MODEL_ORDER: complete, and parents before children ----
// Read from the schema rather than a hand-kept list, so a model added to the
// schema without being added here fails the build instead of being skipped.
{
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
  ok(models.length > 0, "the schema declares models");

  for (const model of models) {
    const key = model.charAt(0).toLowerCase() + model.slice(1);
    ok((dm.MODEL_ORDER as readonly string[]).includes(key), `${model} is in MODEL_ORDER (copied, not silently skipped)`);
  }
  for (const key of dm.MODEL_ORDER) {
    ok(models.some((m) => m.charAt(0).toLowerCase() + m.slice(1) === key), `${key} in MODEL_ORDER still exists in the schema`);
  }
  ok(new Set(dm.MODEL_ORDER).size === dm.MODEL_ORDER.length, "MODEL_ORDER has no duplicates");

  // Every child that requires a parent must be ordered after it, or the copy
  // fails on a foreign key halfway through the move.
  const order = new Map<string, number>(dm.MODEL_ORDER.map((k, i) => [k, i]));
  const before = (child: string, parent: string) => {
    const c = order.get(child), p = order.get(parent);
    if (c === undefined || p === undefined) return true; // not required
    ok(p < c, `${child} is copied after its parent ${parent}`);
    return true;
  };
  before("account", "user");
  before("session", "user");
  before("streamSession", "user");
  before("songRequest", "user");
  before("songLike", "user");
  before("presenceHeartbeat", "user");
  // Donation.userId is optional, so it may lead or follow, but it must exist.
  ok(order.has("donation"), "donation is copied too");
}

console.log(`  ${passed}/${passed + failed} dbmigrate assertions passed`);
if (failed > 0) process.exit(1);
