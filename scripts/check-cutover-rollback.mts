// The database cutover must fail safely, and it must fail legibly.
//
// A cutover is the one operation in this app that can leave the station in a
// state where the files say one thing and the running process another. It was
// attempted for real on 2026-10-10 — a move to SQLite — and did two things wrong.
//
// 1. It could never have succeeded. It runs `npm run build`, whose first step is
//    scripts/run-checks.mjs, which exits 1 on any Node too old to execute the
//    TypeScript suites. The deploy host runs Node 20. The build therefore died
//    at its very first step, before compiling anything. deploy.sh already sets
//    SKIP_UNIT_CHECKS=1 for precisely this reason; the cutover did not, so it
//    inherited a failure that had nothing to do with databases.
//
// 2. The rollback was incomplete, which is the part that actually mattered. It
//    restored prisma/schema.prisma and .env.local — but not the generated
//    Prisma client, and Prisma bakes the provider into the generated code. So it
//    left a SQLite client sitting in node_modules against a Postgres
//    DATABASE_URL. The running process was fine, because it had already loaded
//    the Postgres client into memory two days earlier. That is what makes it a
//    trap: the station looks completely healthy, and the next deploy or restart
//    loads the mismatched client and every query fails. It survived only by
//    luck.
//
// 3. And it reported "Build failed." with no reason, having captured the output
//    and thrown it away. The failure mode that wasted the afternoon.
//
// So: the rebuild must skip the suites, the rollback must restore the client,
// a failed client restore must be reported rather than swallowed, and a failed
// build must say why.
//
// Run: node scripts/check-cutover-rollback.mts (wired as `npm run check:cutover`).
import { readFileSync } from "node:fs";
import path from "node:path";
import { scrub } from "./lib/tsx-scan.mts";

const REPO = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${detail}`}`);
  }
}

const ROUTE = path.join(REPO, "app/api/admin/database/cutover/route.ts");
const raw = readFileSync(ROUTE, "utf8");
const src = scrub(raw);

const rollback = raw.match(/const rollback = async \([\s\S]*?\n {2}\};/);
ok(rollback !== null, "the rollback function is still there");
const rb = rollback?.[0] ?? "";
// Comment-stripped for the assertions below. The prose in this file explains the
// client-restore rule, and a search that matches the explanation instead of the
// code reports a pass for a mutation that deleted the very thing it checks —
// which is what happened on the first run of this check.
const rbCode = scrub(rb);

// ------------------------------------------------- 1. the build must be able to pass

{
  const build = raw.match(/await run\("npm", \["run", "build"\][\s\S]*?\n {2}\}\);/);
  ok(build !== null, "the rebuild step is present");
  const b = build?.[0] ?? "";
  ok(
    /SKIP_UNIT_CHECKS:\s*"1"/.test(b),
    "and it sets SKIP_UNIT_CHECKS=1 — without it the build cannot succeed on the deploy host",
    b
  );
  ok(
    /DATABASE_URL:\s*url/.test(b),
    "and still passes the target DATABASE_URL, which is the whole point of the rebuild"
  );
}

// --------------------------------------------- 2. the rollback must restore the client

{
  ok(/copyFile\(`\$\{SCHEMA\}\.bak-switch`, SCHEMA\)/.test(rb), "the rollback restores the schema");
  ok(/updateEnvFile\(\{\s*DATABASE_URL/.test(rb), "and the environment");
  // The one that was missing.
  ok(
    /prisma",\s*\[\s*"generate"/.test(rb) || /"generate"/.test(rb),
    "AND regenerates the Prisma client, which is provider-specific and was the actual trap"
  );
  ok(
    /DB_PROVIDER:\s*from/.test(rb),
    "restoring DB_PROVIDER to the previous provider, not to a hardcoded one"
  );

  // A rollback that cannot restore the client must say so. Swallowing it is how
  // the mismatch reached production in the first place. Matched on the template
  // literal the catch RETURNS, against comment-stripped source — so neither this
  // file's own explanation of the rule nor a commented-out remnant can stand in
  // for the code.
  ok(
    /catch \(e: any\) \{[\s\S]{0,120}?return `[\s\S]{0,300}?FAILED/.test(rbCode),
    "and reports a failure to restore the client rather than swallowing it",
    rbCode.slice(-300)
  );
  ok(
    /npx prisma generate/.test(rbCode),
    "with the command the operator should run"
  );
  ok(
    !/catch[\s\S]{0,120}return null/.test(rbCode),
    "and never answers `return null` for a restore that failed"
  );
  ok(
    /: Promise<string \| null>/.test(rbCode),
    "so the rollback's return type admits that warning"
  );
}

// --------------------------------------------- 3. a failure must say why

{
  ok(/const whyItFailed = /.test(src), "there is one place that formats a child's failure");
  ok(
    /e\?\.stdout[\s\S]{0,80}e\?\.stderr/.test(src),
    "and it reads both streams, which execFile populates"
  );

  // Each process-failure path must carry its reason. "Build failed." on its own
  // is the report that cost an afternoon. Located by the call it follows, on the
  // RAW file — scrub() blanks "build", so the scrubbed copy cannot be searched
  // for it (the third time this has bitten; see check-maintenance-fallback).
  const buildCatch = raw.match(/await run\("npm", \["run", "build"\][\s\S]*?\}\s*catch \(e: any\) \{[\s\S]*?\n {2}\}/);
  ok(buildCatch !== null, "the build failure path is locatable");
  const bc = buildCatch?.[0] ?? "";
  ok(/\$\{why\}/.test(bc), "and it includes the reason in the message it returns", bc.slice(-220));
  ok(/clientWarning/.test(bc), "and surfaces a failed client restore rather than hiding it");

  // Anchored on DATABASE_URL: url, which only the forward generate call has. The
  // rollback's generate comes first in the file and would otherwise match here.
  const genCatch = raw.match(/"prisma", "generate"[\s\S]*?DATABASE_URL: url[\s\S]*?\}\s*catch \(e: any\) \{[\s\S]*?\n {2}\}/);
  ok(genCatch !== null, "so is the generate failure path");
  const gc = genCatch?.[0] ?? "";
  ok(/\bout\b/.test(gc) && /slice/.test(gc), "and that one reports the captured output too", gc.slice(-200));
}

// --------------------------------------------- 4. still refuses to restart on failure

{
  // Restoring the client must not turn a failure into a restart. The old build
  // must keep serving until a switch genuinely succeeds.
  //
  // Asserted as "each failure path returns", NOT as "PM2_BIN does not appear
  // near a catch". Text cannot distinguish a restart inside a failure path from
  // one that follows a successful build — they look identical in the source, and
  // the version of this check that tried to tell them apart failed on correct
  // code. What is actually load-bearing is that the failure branches exit
  // instead of falling through.
  const buildAt = raw.indexOf('"run", "build"');
  ok(buildAt > 0, "the rebuild step is locatable in the raw source");
  ok(raw.slice(buildAt).indexOf("PM2_BIN") > 0, "and the restart still exists after it");

  const buildBranch = raw.match(/await run\("npm", \["run", "build"\][\s\S]*?catch \(e: any\) \{[\s\S]*?\n {4}return NextResponse\.json/);
  ok(buildBranch !== null, "the build failure branch returns instead of falling through to the restart");

  const genBranch = raw.match(/"prisma", "generate"[\s\S]*?DATABASE_URL: url[\s\S]*?catch \(e: any\) \{[\s\S]*?\n {4}return NextResponse\.json/);
  ok(genBranch !== null, "and so does the generate failure branch");
}

// ------------------------------------------------- the checker checks itself

{
  // The two failure directions, both of which are plausible "fixes".
  // Scoped to the env object, not the bare name: the comment above the call
  // explains the flag in prose, so a whole-file search still finds it.
  const noSkip = raw.replace(', SKIP_UNIT_CHECKS: "1"', "");
  ok(noSkip !== raw && !/SKIP_UNIT_CHECKS: "1"/.test(noSkip), "the mutation that drops SKIP_UNIT_CHECKS really did change the file");

  const noReason = raw.replace('(why ? ` Reason: ${why}` : "")', '""');
  ok(noReason !== raw, "and so did the mutation that strips the reason from the build error");

  // A rollback that regenerates with no DATABASE_URL would still mismatch.
  ok(
    /DATABASE_URL:\s*process\.env\.DATABASE_URL/.test(rb),
    "the client is regenerated against the previous DATABASE_URL, not a blank one"
  );
  ok(
    !/env:\s*\{\s*\}\s*\}/.test(rb),
    "and never against an empty environment"
  );
}

console.log(`  ${passed}/${passed + failed} cutover-rollback assertions passed`);
if (failed) process.exit(1);