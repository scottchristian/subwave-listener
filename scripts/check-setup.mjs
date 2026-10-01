#!/usr/bin/env node
// The setup gate decides whether an unauthenticated request may reach the routes
// that write Google credentials and name an administrator. Getting it wrong
// hands the station to anyone who finds the URL, and getting it wrong is
// invisible: the wizard still works perfectly for the operator either way.
//
// So it is tested rather than reasoned about. The path rule is a pure function
// (lib/setup.ts → isSetupPath), which is why this needs no server and no
// database — only the decision itself, from both sides.
//
//   node scripts/check-setup.mjs
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

// The rules under test, compiled straight from the repo so this cannot drift
// from what actually ships. A generated entry, because esbuild only keeps what
// the entry point can reach — and handoverPlan lives beside the gate, not in it.
const entry = path.join(here, ".setup-entry-under-test.ts");
const src = path.join(here, ".setup-under-test.mjs");
writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(path.join(repo, "lib/setup.ts"))};`,
    `export * from ${JSON.stringify(path.join(repo, "lib/handover.ts"))};`,
  ].join("\n")
);
const bundled = execFileSync(
  "npx",
  ["esbuild", entry, "--bundle", "--format=esm", "--platform=node", `--outfile=${src}`],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
);
if (!existsSync(src)) throw new Error("esbuild produced no output:\n" + bundled);
const { isSetupPath, looksConfigured, handoverPlan, SETUP_PATH, SETUP_API } = await import(
  `file://${src}?v=${Date.now()}`
);

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
  if (actual === expected) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}  (expected ${expected}, got ${actual})`);
  }
};

console.log("Setup gate — open (setup not finished yet)\n");

check("the wizard page itself is reachable", isSetupPath(SETUP_PATH, false), true);
check("its status endpoint is reachable", isSetupPath(`${SETUP_API}/status`, false), true);
check("its apply endpoint is reachable", isSetupPath(`${SETUP_API}/apply`, false), true);
check("a nested api path is reachable", isSetupPath(`${SETUP_API}/apply/extra`, false), true);
check("a trailing slash on the page is reachable", isSetupPath(`${SETUP_PATH}/`, false), true);

console.log("\nSetup gate — closed (setup finished)\n");

check("the wizard page is closed", isSetupPath(SETUP_PATH, true), false);
check("its status endpoint is closed", isSetupPath(`${SETUP_API}/status`, true), false);
check("its apply endpoint is closed", isSetupPath(`${SETUP_API}/apply`, true), false);
check("a nested api path is closed", isSetupPath(`${SETUP_API}/apply/extra`, true), false);

console.log("\nSetup gate — closed, and these must never be open at any stage\n");

// These are the paths that must never be reachable unauthenticated, in either
// state. If any of them ever returns true, the gate has a hole.
const NEVER = [
  "/",
  "/admin",
  "/admin/anything",
  "/likes",
  "/api/settings",
  "/api/admin/users",
  "/api/admin/identity/save",
  "/api/admin/database/cutover",
  "/api/webhooks/bmac",
  "/api/auth/callback/google",
  // Prefix traps: "/setup" must not match "/setup-evil", and the api base must
  // not match a longer word that merely starts the same.
  "/setup-evil",
  "/setupx",
  "/api/setupbackdoor",
  "/api/setupx/apply",
];
for (const p of NEVER) {
  check(`${p} is closed while setting up`, isSetupPath(p, false), false);
  check(`${p} is closed when done`, isSetupPath(p, true), false);
}

// The upgrade hazard: deploying code containing the wizard must not expose it
// on a station that was already set up. That is decided by looking at the env,
// so it is worth pinning down.
console.log("\nAlready-configured detection (decides whether the wizard ever opens)\n");

const CONFIGURED = {
  NEXTAUTH_SECRET: "x",
  GOOGLE_CLIENT_ID: "y.apps.googleusercontent.com",
  DATABASE_URL: "file:../data/station.db",
  NEXT_PUBLIC_STATION_NAME: "Some Station",
};
check("a fully configured install is recognised", looksConfigured(CONFIGURED), true);

// The case that used to end the wizard early and strand the operator. Steps one
// to three write exactly these three values, so on those alone a half-finished
// install is indistinguishable from one that predates the wizard — and this
// function closing itself is what locked an operator out of the page that names
// their station, with no way back but deleting a file they had never heard of.
check(
  "an install partway through the wizard is NOT treated as configured",
  looksConfigured({
    NEXTAUTH_SECRET: "x",
    GOOGLE_CLIENT_ID: "y.apps.googleusercontent.com",
    DATABASE_URL: "file:../data/station.db",
  }),
  false
);
check(
  "secrets alone do not close the wizard",
  looksConfigured({ NEXTAUTH_SECRET: "x" }),
  false
);
check(
  "secrets and credentials alone do not close the wizard",
  looksConfigured({ NEXTAUTH_SECRET: "x", GOOGLE_CLIENT_ID: "y.apps.googleusercontent.com" }),
  false
);

for (const missing of ["NEXTAUTH_SECRET", "GOOGLE_CLIENT_ID", "DATABASE_URL", "NEXT_PUBLIC_STATION_NAME"]) {
  const partial = { ...CONFIGURED, [missing]: "" };
  check(`a missing ${missing} means not configured`, looksConfigured(partial), false);
}
check("an entirely empty env is not configured", looksConfigured({}), false);
check(
  "whitespace does not count as configured",
  looksConfigured({ NEXTAUTH_SECRET: "  ", GOOGLE_CLIENT_ID: "y", DATABASE_URL: "z" }),
  false
);
check(
  "undefined values do not count as configured",
  looksConfigured({ NEXTAUTH_SECRET: undefined, GOOGLE_CLIENT_ID: "y", DATABASE_URL: "z" }),
  false
);

// The root handover is offered root-only, and automated only when there is a
// process to hand over. Offering it when it cannot work would strand a novice
// mid-setup with a half-changed server.
console.log("\nHandover offer (should this page offer to do it?)\n");

const base = { runningAsRoot: true, pm2Configured: true, userExists: false, icecastConfigExists: true };

check("root + pm2 → automated", handoverPlan(base).canAutomate, true);
check(
  "root + pm2 → no reason given",
  handoverPlan(base).reason === undefined,
  true
);

const noPm2 = { ...base, pm2Configured: false };
check("root, no pm2 → manual only", handoverPlan(noPm2).canAutomate, false);
check(
  "root, no pm2 → says why",
  /not started by pm2/i.test(handoverPlan(noPm2).reason || ""),
  true
);

const notRoot = { ...base, runningAsRoot: false };
check("not root → nothing offered", handoverPlan(notRoot).canAutomate, false);
check("not root → says it is already fine", /already running/i.test(handoverPlan(notRoot).reason || ""), true);

console.log("\nHandover commands (shown before anything is changed)\n");

const plan = handoverPlan(base);
const allCommands = plan.manual.join("\n");
for (const expected of [
  "useradd",
  "usermod -aG icecast",
  "chmod 660",
  "visudo -cf",
  "chown -R",
  "chmod 600",
  "pm2 startup systemd -u",
  "systemctl disable pm2-root.service",
]) {
  check(`manual commands include ${expected}`, allCommands.includes(expected), true);
}
check(
  "sudo rule is scoped to one command",
  /ALL=\(root\) NOPASSWD: \/usr\/bin\/systemctl reload icecast2/.test(allCommands),
  true
);
check(
  "sudo rule does NOT grant bare systemctl",
  !/NOPASSWD: ALL|NOPASSWD: \/usr\/bin\/systemctl \*/.test(allCommands),
  true
);
check("a revert is offered", plan.revert.length > 0, true);
check("revert removes the sudo rule", plan.revert.some((r) => r.includes("rm -f")), true);
check(
  "revert restores root ownership",
  plan.revert.some((r) => r.includes("chown -R root:root")),
  true
);

// Without a relay on the box, the group grant is pointless noise.
const noIcecast = { ...base, icecastConfigExists: false };
check(
  "no relay config → no icecast group grant",
  handoverPlan(noIcecast).manual.some((m) => m.includes("usermod -aG icecast")),
  false
);
check(
  "no relay config → no chmod of the relay config",
  handoverPlan(noIcecast).manual.some((m) => m.includes("chmod 660")),
  false
);

// An existing account must not be re-created.
check(
  "an existing account is reused, not recreated",
  handoverPlan({ ...base, userExists: true }).manual.some((m) => m.startsWith("useradd")),
  false
);

  // THE ACCOUNT NAME. This was derived from package.json, which is named
  // "subwave-web-player", so the wizard created subwave-web-player while every
  // document, every example command and any existing station said
  // subwave-listener. Two operators following the two routes ended up with two
  // differently named accounts, and the handover could not recognise the one it
  // was meant to be reusing. Pinned here because nothing else would have caught
  // it: the code was self-consistent and the docs were self-consistent, they
  // just disagreed with each other.
  check(
    "the account is named subwave-listener",
    plan.manual.some((m) => /useradd.*subwave-listener/.test(m)),
    true
  );
  check(
    "no command names the account after the package",
    allCommands.includes("subwave-web-player"),
    false
  );
  check(
    "the home directory matches the account",
    plan.manual.some((m) => m.includes("/var/lib/subwave-listener")),
    true
  );
  check(
    "the sudoers file matches the account",
    allCommands.includes("/etc/sudoers.d/subwave-listener"),
    true
  );

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(src, { force: true });
rmSync(entry, { force: true });
process.exit(fail === 0 ? 0 : 1);
