// Every account must end a sign-in with an address that can actually be shown.
//
// The gap this exists for: the adapter's createUser wrote `email: idx(email)`
// and `name: enc(name)` but not `emailEnc`. NextAuth has no knowledge of that
// column, so nothing else ever filled it either — the only writer in the repo
// was scripts/encrypt-pii.mjs, a one-off migration. The result was an account
// that could be found by its blind index and used normally in every way that
// matters, and displayed as a bare `Name ()` in the admin People list. Two of
// eleven production accounts were in that state, and they were the two newest,
// because the migration had already run before they arrived.
//
// It could not be repaired from the database. `email` is a blind index by then,
// so the plaintext exists nowhere; encrypt-pii.mjs meets precisely that case and
// declines it on purpose. The only place the real address is ever in hand again
// is the signIn callback, which receives it on every sign-in.
//
// So the rules, all in app/api/auth/[...nextauth]/route.ts:
//
//   - createUser stores emailEnc, not just the index
//   - signIn backfills emailEnc for an existing account that lacks it
//   - that backfill is guarded on enc() returning a value, so a missing
//     encryption key can never null out an address already on file
//   - both repairs share ONE write, because the free tier counts them
//
// This reads the code, not a running app, so it is instant and hermetic. The
// extractors throw rather than returning "" when the shape is not found — a
// check that quietly stops matching is the failure mode that hid a hook-order
// bug for hours through two different versions of the checker meant to catch it.
//
// Run: node scripts/check-signin-email.mts (wired as `npm run check:signin`).
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

/** The `createUser` override, or throw. */
function createUserBody(src: string): string {
  const m = src.match(/async createUser\(([\s\S]*?)\n {2}\},/);
  if (!m) throw new Error("createUser override not found — the adapter shape changed");
  return m[1];
}

/** The `signIn` callback, or throw. */
function signInBody(src: string): string {
  const m = src.match(/async signIn\(\{([^}]*)\}\)([\s\S]*?)\n {4}async session/);
  if (!m) throw new Error("signIn callback not found — the callback shape changed");
  return m[2];
}

/** Reasons this source would fail the rules, so the checks below can be tested. */
function audit(src: string): string[] {
  const bad: string[] = [];
  let create = "";
  let signIn = "";
  try {
    create = createUserBody(src);
  } catch (e) {
    return [(e as Error).message];
  }
  try {
    signIn = signInBody(src);
  } catch (e) {
    return [(e as Error).message];
  }

  if (!/emailEnc\s*:\s*enc\(/.test(create)) bad.push("createUser does not store emailEnc");
  if (!/email\s*:\s*idx\(/.test(create)) bad.push("createUser does not store the blind index");
  if (!/name\s*:\s*enc\(/.test(create)) bad.push("createUser does not encrypt the name");
  // A plaintext address must never reach the row; that is the whole design.
  if (/(^|[^.\w])email\s*:\s*email\b/.test(create) || /\.\.\.rest/.test(create) === false) {
    if (/(^|[^.\w])email\s*:\s*email\b/.test(create)) bad.push("createUser stores a plaintext address");
  }

  if (!/existingUser\.emailEnc/.test(signIn)) bad.push("signIn never looks at the stored emailEnc");
  if (!/enc\(/.test(signIn)) bad.push("signIn cannot re-encrypt anything");

  // The value must reach the write only through a guard, never straight from
  // enc(): a missing key returns null, and null over a stored address loses it.
  const guarded = /const\s+\w+\s*=\s*enc\([^)]*\)\s*;[\s\S]{0,120}?if\s*\(\s*\w+\s*&&/.test(signIn);
  const inlineGuarded = /if\s*\(\s*\w+\s*&&\s*!existingUser\.emailEnc\s*\)\s*\{?\s*(?:data\.\w+\s*=\s*)?\w+\s*;/.test(
    signIn
  );
  if (!guarded && !inlineGuarded) bad.push("the backfill is not guarded on enc() returning a value");

  // Two writes where one would do is the thing the free tier notices.
  const updates = (signIn.match(/prisma\.user\.update/g) ?? []).length;
  if (updates !== 1) bad.push(`signIn performs ${updates} user updates; both repairs must share one write`);
  if (!/Object\.keys\(data\)\.length\s*>\s*0/.test(signIn)) bad.push("the write is not conditional on there being something to change");

  return bad;
}

// ------------------------------------------------------------------ the app

const ROUTE = path.join(REPO, "app/api/auth/[...nextauth]/route.ts");
const raw = readFileSync(ROUTE, "utf8");
const route = scrub(raw);

let findings: string[] = [];
try {
  findings = audit(route);
} catch (e) {
  findings = [(e as Error).message];
}
for (const f of findings) console.log(`  FAIL  ${f}`);
ok(findings.length === 0, "every sign-in leaves an address that can be displayed", findings);

// The reason, so a later reader does not "simplify" the column away again.
ok(
  /cannot be recovered[\s\S]{0,400}encrypt-pii\.mjs/.test(raw),
  "and the backfill says why the missing value cannot be recovered from the database"
);
ok(
  /both repairs —/.test(raw.replace(/\s+/g, " ")) || /One update serving both purposes/.test(raw),
  "and that the two repairs share one write on purpose"
);

// ------------------------------------------------- the checker checks itself

const GOOD = `
  async createUser({ name, email, ...rest }: any) {
    return withWake(baseAdapter.createUser)({
      ...rest,
      email: idx(email),
      emailEnc: enc(email),
      name: enc(name),
    });
  },
    async signIn({ user }) {
      if (!existingUser) {
      } else {
        const data = {};
        const recovered = enc(email);
        if (recovered && !existingUser.emailEnc) data.emailEnc = recovered;
        if (Object.keys(data).length > 0) {
          await withWake(prisma.user.update.bind(prisma.user))({ where: { email: token }, data });
        }
      }
      return true;
    },
    async session({ session, user }) {`;

ok(audit(GOOD).length === 0, "a correct sign-in path passes", audit(GOOD));

{
  // The bug as it shipped: index only, and no backfill anywhere.
  const f = audit(`
  async createUser({ name, email, ...rest }: any) {
    return withWake(baseAdapter.createUser)({
      ...rest,
      email: idx(email),
      name: enc(name),
    });
  },
    async signIn({ user }) {
      if (!existingUser) {
      } else if (isAdmin && !existingUser.isAdmin) {
        await withWake(prisma.user.update.bind(prisma.user))({ where: { email: token }, data: {} });
      }
      return true;
    },
    async session({ session, user }) {`);
  ok(f.some((x) => /createUser does not store emailEnc/.test(x)), "the shipped bug is caught", f);
  ok(f.some((x) => /never looks at the stored emailEnc/.test(x)), "including the missing backfill", f);
  ok(
    f.some((x) => /write is not conditional/.test(x)),
    "and the write that fires whether or not there is anything to change",
    f
  );
}

{
  // An unguarded enc() can null out an address that was already on file.
  const f = audit(GOOD.replace("if (recovered && !existingUser.emailEnc)", "if (!existingUser.emailEnc)"));
  ok(
    f.some((x) => /not guarded on enc\(\)/.test(x)),
    "an unguarded backfill is caught",
    f
  );
}

{
  // Two separate writes: correct data, wrong cost.
  const f = audit(
    GOOD.replace(
      "if (Object.keys(data).length > 0) {\n          await withWake(prisma.user.update.bind(prisma.user))({ where: { email: token }, data });\n        }",
      "await withWake(prisma.user.update.bind(prisma.user))({ where: { email: token }, data });\n        await withWake(prisma.user.update.bind(prisma.user))({ where: { email: token }, data });"
    )
  );
  ok(f.some((x) => /must share one write/.test(x)), "splitting the repairs into two writes is caught", f);
}

{
  // A plaintext address must never reach the row.
  const f = audit(GOOD.replace("email: idx(email),", "email: email,"));
  ok(f.some((x) => /plaintext address/.test(x)), "storing the plaintext address is caught", f);
}

{
  // If the adapter shape moves, say so rather than passing on nothing found.
  let threw = false;
  try {
    audit("export const authOptions = {};");
  } catch {
    threw = true;
  }
  ok(threw || audit("export const authOptions = {};").length > 0, "a route it cannot read is a failure, not a pass");
}

console.log(`  ${passed}/${passed + failed} sign-in email assertions passed`);
if (failed) process.exit(1);