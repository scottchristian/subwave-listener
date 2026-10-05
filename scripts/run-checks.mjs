#!/usr/bin/env node
// The test gate that runs on every compile.
//
// Why a script rather than `&& npm run check:unit`: the suites are TypeScript,
// executed by Node's own type stripping, and that only exists on Node 22.6+.
// A build that hard-coded the suite would therefore fail on the deploy host
// (Node 20) with ERR_UNKNOWN_FILE_EXTENSION, and a build that skipped it
// silently would be exactly the regression-proofing this is meant to provide.
//
// So the three outcomes are all explicit:
//   - capable runtime  -> run the suite; a failure fails the build
//   - incapable runtime-> FAIL, naming the fix, rather than build untested
//   - SKIP_UNIT_CHECKS=1 -> skip, printing why (the deploy path; see deploy.sh)
//
// The deploy host opts out on purpose: it mirrors a commit that already passed
// these suites on a capable runtime, and its Node is too old to run them. That
// is a reason to say out loud, not a reason to be quiet.
import { spawnSync } from "node:child_process";

const SKIP = process.env.SKIP_UNIT_CHECKS;
const [major, minor] = process.versions.node.split(".").map(Number);
const canStripTypes = major > 22 || (major === 22 && minor >= 6);

if (SKIP === "1") {
  console.log("[checks] skipped (SKIP_UNIT_CHECKS=1) — this runtime cannot execute the TypeScript suites.");
  console.log("[checks] the suite must pass on a capable runtime before this commit is deployed.");
  process.exit(0);
}

if (!canStripTypes) {
  console.error(`[checks] FAILED: Node ${process.versions.node} cannot run the TypeScript suites.`);
  console.error("[checks] Node 22.6 or newer is required to execute them (type stripping).");
  console.error("[checks] Upgrade Node, or set SKIP_UNIT_CHECKS=1 to build without them — deliberately.");
  process.exit(1);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const r = spawnSync(npm, ["run", "--silent", "check:unit"], { stdio: "inherit" });
if (r.error) {
  console.error("[checks] could not run the suite:", r.error.message);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`[checks] FAILED (exit ${r.status}) — the build is aborted, not shipped untested.`);
  process.exit(r.status ?? 1);
}
console.log("[checks] passed.");
