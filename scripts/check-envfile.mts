// updateEnvFile rewrites the running server's .env.local in place. Getting it
// wrong destroys secrets: a dropped line loses the encryption key or the admin
// password, and a mangled one leaves the app booting against garbage. The
// panel shows the file's contents, so what leaves here is shown to an operator.
//
// Every case runs against a real temp file, because the guarantees are
// filesystem guarantees: the backup exists before the write, unrelated lines
// are byte-identical afterwards, and a blank clears rather than writes "".
//
// Run: npm run check:envfile
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const { updateEnvFile, ENV_FILE } = await import("../lib/envfile.ts");

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-envfile-"));
const cleanup = () => fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
process.on("exit", cleanup);

let seq = 0;
/** Write a fresh env file and return its path plus a reader. */
async function envFile(contents: string) {
  const file = path.join(tmp, `.env.local.${seq++}`);
  await fs.writeFile(file, contents, "utf8");
  return {
    file,
    read: () => fs.readFile(file, "utf8"),
    exists: (p: string) => fs.access(p).then(() => true, () => false),
  };
}

const BASE = [
  "NEXTAUTH_SECRET=\"keep-me\"",
  "PII_ENCRYPTION_KEY=\"aaaabbbbccccdddd\"",
  "# a comment worth keeping",
  "",
  "DATABASE_URL=\"postgresql://u:p@h/db\"",
  "SUBWAVE_API_URL=\"https://radio.example.com/api\"",
].join("\n");

// ---- the everyday save: one key changes, everything else is untouched ----
{
  const f = await envFile(BASE);
  const { updated, backup } = await updateEnvFile({ SUBWAVE_API_URL: "https://new.example.com/api" }, f.file);
  const after = await f.read();
  ok(updated.length === 1 && updated[0] === "SUBWAVE_API_URL", "reports exactly the key it changed");
  ok(after.includes('SUBWAVE_API_URL="https://new.example.com/api"'), "the new value is written");
  ok(after.includes('NEXTAUTH_SECRET="keep-me"'), "an unrelated secret survives");
  ok(after.includes("# a comment worth keeping"), "comments survive");
  ok(after.includes('DATABASE_URL="postgresql://u:p@h/db"'), "a url with credentials is not corrupted");
  ok(await f.exists(backup), "a backup file exists");
  ok((await fs.readFile(backup, "utf8")) === BASE, "the backup holds the original contents byte-for-byte");
  ok(backup.startsWith(f.file + ".bak-"), "the backup sits beside the file it replaces");
}

// ---- a key that is absent gets appended rather than silently dropped ----
{
  const f = await envFile(BASE);
  const { updated } = await updateEnvFile({ PM2_APP_NAME: "causewayfm" }, f.file);
  const after = await f.read();
  ok(updated.includes("PM2_APP_NAME"), "a new key reports as updated");
  ok(after.includes('PM2_APP_NAME="causewayfm"'), "a new key is appended");
  ok(after.includes('NEXTAUTH_SECRET="keep-me"'), "and nothing else moved");
}

// ---- blank clears the line, so the process env takes over again ----
{
  const f = await envFile(BASE);
  await updateEnvFile({ SUBWAVE_API_URL: "" }, f.file);
  const after = await f.read();
  ok(!after.includes("SUBWAVE_API_URL"), "a blank value removes the line rather than writing \"\"");
  ok(!after.includes('SUBWAVE_API_URL=""'), "no empty assignment is left behind");
  ok(after.includes('DATABASE_URL="postgresql://u:p@h/db"'), "other keys are untouched");
}

// ---- a missing key with a blank value adds nothing ----
{
  const f = await envFile(BASE);
  const { updated } = await updateEnvFile({ NOT_SET_ANYWHERE: "" }, f.file);
  ok(!updated.includes("NOT_SET_ANYWHERE"), "clearing an absent key reports nothing");
  ok(!(await f.read()).includes("NOT_SET_ANYWHERE"), "and writes nothing");
}

// ---- several keys at once, including one new and one cleared ----
{
  const f = await envFile(BASE);
  const { updated } = await updateEnvFile(
    { NEXTAUTH_SECRET: "rotated", SUBWAVE_API_URL: "", PM2_APP_NAME: "causewayfm" },
    f.file
  );
  const after = await f.read();
  // A cleared key is deliberately not "updated" — it has no value to report,
  // and counting it would make the panel claim a change it cannot show.
  ok(updated.length === 2 && !updated.includes("SUBWAVE_API_URL"), "updated and appended keys report; a cleared one does not");
  ok(after.includes('NEXTAUTH_SECRET="rotated"'), "an updated secret is rotated in place");
  ok(!after.includes("SUBWAVE_API_URL"), "a cleared key is gone");
  ok(after.includes('PM2_APP_NAME="causewayfm"'), "a new key is appended");
  ok(after.includes('PII_ENCRYPTION_KEY="aaaabbbbccccdddd"'), "untouched secrets survive a multi-key save");
}

// ---- quoting: a value with a quote or backslash must not break the file ----
{
  const f = await envFile(BASE);
  const awkward = 'he said "cheers" \\ then left';
  await updateEnvFile({ NEXTAUTH_SECRET: awkward }, f.file);
  const after = await f.read();
  const line = after.split("\n").find((l) => l.startsWith("NEXTAUTH_SECRET="))!;
  // The file must still parse as KEY="value", i.e. exactly one unescaped pair of quotes.
  ok(line.startsWith('NEXTAUTH_SECRET="') && line.endsWith('"'), "quotes and backslashes are escaped, line stays well-formed");
  ok(line.includes('\\"cheers\\"') && line.includes("\\\\"), "the inner quotes and backslash are escaped");
  ok(after.includes('SUBWAVE_API_URL="https://radio.example.com/api"'), "the escaping did not bleed into other keys");
}

// ---- multi-line and prefix-lookalike keys ----
{
  const f = await envFile(["A=1", "MY_PREFIX_KEY_A=\"keep\"", "A_SUFFIX=\"keep too\""].join("\n"));
  await updateEnvFile({ A: "2" }, f.file);
  const after = await f.read();
  ok(after.includes('A="2"'), "the exact key is updated");
  ok(after.includes('MY_PREFIX_KEY_A="keep"'), "a longer key containing A is untouched");
  ok(after.includes('A_SUFFIX="keep too"'), "a key merely starting with the same letter is untouched");
}
// A comment mentioning the key must not be rewritten.
{
  const f = await envFile(["# NEXTAUTH_SECRET is rotated by the admin panel", 'A="1"'].join("\n"));
  await updateEnvFile({ A: "2" }, f.file);
  const after = await f.read();
  ok(after.includes("# NEXTAUTH_SECRET is rotated"), "a commented-out line is left alone");
}

// ---- a file with no trailing newline still gets the new key ----
{
  const f = await envFile('A="1"');
  const { updated } = await updateEnvFile({ B: "2" }, f.file);
  const after = await f.read();
  ok(updated.includes("B"), "a key is appended without a trailing newline");
  ok(after.includes('A="1"') && after.includes('B="2"'), "both lines are present and parseable");
}

// ---- unreadable file: fail with the path, and change nothing ----
{
  let msg = "";
  try {
    await updateEnvFile({ A: "2" }, path.join(tmp, "does-not-exist"));
  } catch (e: any) {
    msg = String(e?.message || "");
  }
  ok(/cannot read/.test(msg) && /does-not-exist/.test(msg), "a missing file names itself in the error");
}

// ---- ENV_FILE is absolute, because the panel runs from a different cwd ----
ok(path.isAbsolute(ENV_FILE), "the env file path is absolute");

console.log(`  ${passed}/${passed + failed} envfile assertions passed`);
if (failed > 0) process.exit(1);
