// The listener text line: phone normalisation, opt-out handling, the reminder
// tick, webhook signature verification, and — the promise the confirm dialog
// makes — that unlinking erases the transcript, bells and reminder claims.
//
// Hermetic: a throwaway sqlite client and database in the OS temp dir. Nothing
// in the repo is touched except prisma/.gen-test.prisma, removed on the way out.
//
// Run: node --import ./scripts/test-register.mjs scripts/check-phone.mts
// (wired as `npm run check:phone`; needs TEST_PRISMA_CLIENT, set by the script).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const REPO = process.env.TEST_REPO_ROOT || process.cwd();

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` (got ${JSON.stringify(detail)})`}`);
  }
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-phone-test-"));
const clientDir = path.join(REPO, ".test-client");
const hashFile = path.join(clientDir, "schema.sha256");
const schemaPath = path.join(REPO, "prisma", ".gen-test.prisma");
if (!process.env.TEST_PRISMA_CLIENT) throw new Error("TEST_PRISMA_CLIENT is not set — run via `npm run check:phone`");

async function cleanup() {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  await fs.rm(schemaPath, { force: true }).catch(() => {});
}
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

try {
  // ---- throwaway sqlite client (hash-gated, shared with the other DB suites) ----
  await run("node", [path.join(REPO, "scripts", "gen-schema.mjs"), "sqlite", schemaPath]);
  let schema = await fs.readFile(schemaPath, "utf8");
  schema = schema.replace(
    /generator client \{[\s\S]*?\}/,
    `generator client {\n  provider = "prisma-client-js"\n  output = "${clientDir}"\n}`
  );
  await fs.writeFile(schemaPath, schema);
  const hash = crypto.createHash("sha256").update(schema).digest("hex");
  const cached = await fs.readFile(hashFile, "utf8").catch(() => "");
  if (cached.trim() !== hash || !(await fs.stat(path.join(clientDir, "index.js")).catch(() => null))) {
    await fs.rm(clientDir, { recursive: true, force: true });
    await run(path.join(REPO, "node_modules", ".bin", "prisma"), ["generate", "--schema", schemaPath], {
      cwd: REPO,
      timeout: 180000,
    });
    await fs.mkdir(clientDir, { recursive: true });
    await fs.writeFile(hashFile, hash);
    console.log("  (test prisma client generated)");
  }

  // ---- env before the modules under test load ----
  process.env.DATABASE_URL = `file:${path.join(tmpRoot, "phone.db")}`;
  process.env.DB_PROVIDER = "sqlite";
  process.env.NEXTAUTH_SECRET = "phone-test-secret";
  process.env.NEXTAUTH_URL = "https://example.test";
  process.env.NEXT_PUBLIC_STATION_NAME = "Test FM";

  await run(
    path.join(REPO, "node_modules", ".bin", "prisma"),
    ["db", "push", "--schema", schemaPath, "--accept-data-loss"],
    { cwd: REPO, timeout: 120000, env: process.env }
  );

  const { default: prisma } = await import("../lib/prisma.ts");
  const { normalizePhone, dialCodeForTimezone, isOptOut, formatPhoneInput } = await import("../lib/phone.ts");
  const { verifyWebhookSignature } = await import("../lib/linq.ts");
  const textline = await import("../lib/textline.ts");

  // ---------------------------------------------------------------- pure
  ok(normalizePhone("0408 344 123", "+61") === "+61408344123", "national number gets the station country code");
  ok(normalizePhone("+61 408 344 123", "+61") === "+61408344123", "+CC number is untouched");
  ok(normalizePhone("61408344123", "+61") === "+61408344123", "CC without a plus is not doubled");
  ok(normalizePhone("(04) 0834-4123", "+61") === "+61408344123", "punctuation is stripped");
  ok(normalizePhone("0408 344 123", "") === null, "no country code means no guess");
  ok(normalizePhone("12345", "+61") === null, "too short is refused");
  ok(normalizePhone("hello", "+61") === null, "letters are refused");
  ok(dialCodeForTimezone("Australia/Sydney") === "+61", "Sydney maps to +61");
  ok(dialCodeForTimezone("Pacific/Auckland") === "+64", "Auckland maps to +64");
  ok(dialCodeForTimezone("Mars/Olympus") === "", "an unknown zone is never guessed");

  ok(isOptOut("STOP") && isOptOut("UNSUBSCRIBE") && isOptOut("QUIT"), "standard opt-out words are honoured");
  ok(isOptOut("OPT OUT") && isOptOut("opt-out") && isOptOut(" Opt  Out "), "OPT OUT tolerates casing and spacing");
  ok(!isOptOut("stop"), "lower-case stop is a song named stop, not an opt-out");
  ok(!isOptOut("please STOP the music"), "opt-out is the whole message, not a word in one");

  // ----------------------------------------------------------- formatting
  ok(formatPhoneInput("0408826585", "+61") === "0408 826 585", "a national number is grouped 4-3-3");
  ok(formatPhoneInput("0408 826 585", "+61") === "0408 826 585", "re-formatting is idempotent");
  ok(formatPhoneInput("04086", "+61") === "0408 6", "a partial number groups as far as it goes");
  ok(formatPhoneInput("(04) 0834-4123", "+61") === "0408 344 123", "punctuation is replaced by spaces");
  ok(formatPhoneInput("408826585", "+61") === "408 826 585", "a mobile typed without the trunk zero groups 3-3-3");
  ok(formatPhoneInput("+61 408 826 585", "+61") === "408 826 585", "the station's own code is left to the prefix chip");
  ok(formatPhoneInput("4088265855", "+1") === "408 826 5855", "US numbers group 3-3-4");
  ok(formatPhoneInput("07911123456", "+44") === "07911 123456", "UK numbers group 5-6");
  ok(formatPhoneInput("+1 408 826 5855", "+61") === "+1 408 826 5855", "another country's number is never rearranged");
  ok(formatPhoneInput("", "+61") === "" && formatPhoneInput("+", "+61") === "+", "empty and lone plus survive");
  ok(normalizePhone(formatPhoneInput("0408826585", "+61"), "+61") === "+61408826585", "the formatted value still normalizes — spaces are ignored");

  // ---------------------------------------------------------------- link
  await prisma.user.create({ data: { id: "u1" } });

  const sent: { to: string; body: string; opts: any }[] = [];
  let failNext: string | null = null;
  const send: any = async (to: string, body: string, opts: any = {}) => {
    if (failNext) {
      const error = failNext;
      failNext = null;
      return { ok: false, error };
    }
    sent.push({ to, body, opts });
    return { ok: true, id: `m${sent.length}`, chatId: "c1" };
  };

  failNext = "send failed (network)";
  const failedSend = await textline.startLink("u1", "0408 344 123", { defaultCountry: "+61", send });
  ok(failedSend.ok === false && failedSend.code === "send_failed", "a failed send is reported as such");
  ok(
    !/check the number/i.test(failedSend.ok === false ? failedSend.message : ""),
    "...without blaming the number, which is not what a network failure means"
  );
  ok(
    (await prisma.phoneVerification.findUnique({ where: { userId: "u1" } })) === null,
    "...and leaves no pending code, so no code box is shown"
  );

  // A shared-line policy refusal is the one failure a listener can act on.
  await prisma.user.create({ data: { id: "u0" } });
  failNext = "send failed (403 2027)";
  const blocked = await textline.startLink("u0", "0408 344 123", { defaultCountry: "+61", send });
  ok(blocked.ok === false && blocked.code === "send_failed", "a 403 from Linq is a send failure");
  ok(
    blocked.ok === false && /add your number/i.test(blocked.message),
    "...and says the owner has to add the number on a shared line",
    blocked.ok === false ? blocked.message : blocked
  );

  const started = await textline.startLink("u1", "0408 344 123", { defaultCountry: "+61", send });
  ok(started.ok === true, "a successful send starts the link");
  const sentCount = sent.length;

  const t0 = Date.now();
  const tooSoon = await textline.startLink("u1", "0408 344 123", { defaultCountry: "+61", send, now: t0 });
  ok(tooSoon.ok === false && tooSoon.code === "too_soon", "a second code inside the cooldown is refused");
  ok(sent.length === sentCount, "...and no extra text goes out");

  const resent = await textline.startLink("u1", "0408 344 123", {
    defaultCountry: "+61", send, now: t0 + textline.CODE_RESEND_MS,
  });
  ok(resent.ok === true, "a code is allowed again once the cooldown passes");

  const pending = await prisma.phoneVerification.findUnique({ where: { userId: "u1" } });
  ok(!!pending && pending.phone === "+61408344123", "the pending row carries the E.164 number");
  const code = String(sent[sent.length - 1].body.match(/\b(\d{6})\b/)?.[1] || "");
  ok(/^\d{6}$/.test(code), "the code is six digits in the message");
  ok(!pending!.codeHash.includes(code), "the code is stored as a hash, never in the clear");

  const missed = code === "111111" ? "222222" : "111111";
  const wrong = await textline.verifyLink("u1", missed, { send });
  ok(wrong.ok === false && wrong.code === "invalid_code", "a wrong code is refused");
  ok((await prisma.phoneVerification.findUnique({ where: { userId: "u1" } }))!.attempts === 1, "...and counts the attempt");

  const verified = await textline.verifyLink("u1", code, { send });
  ok(verified.ok === true, "the right code links the phone");
  const contact = await prisma.phoneContact.findUnique({ where: { userId: "u1" } });
  ok(!!contact?.verifiedAt, "the contact is verified");
  const welcome = sent[sent.length - 1];
  ok(welcome.to === "+61408344123" && /linked/i.test(welcome.body), "a welcome text is sent after verification");
  ok((await prisma.textMessage.count({ where: { contactId: contact!.id, direction: "out" } })) === 1, "...and recorded in the thread");

  const status = await textline.phoneStatus("u1");
  ok(status.linked && status.phone === "+61408344123", "status reports the linked number");
  ok(status.messages.length === 1 && status.messages[0].direction === "out", "status includes the thread");

  const bell = await textline.setShowAlert("u1", "s1", true);
  ok(bell.ok === true, "a bell can be switched on");
  ok((await textline.phoneStatus("u1")).showIds.includes("s1"), "...and reads back");

  // ---------------------------------------------------------------- reminders
  const grid: Record<string, (string | null)[]> = {};
  for (let d = 0; d < 7; d++) grid[String(d)] = Array.from({ length: 24 }, (_, h) => (h === 15 ? "s1" : null));
  const schedule = { grid, shows: [{ id: "s1", name: "Harbour Sounds" }], timezone: "Australia/Sydney" };
  // 14:50 Sydney, AEST (+10) — safely away from a DST boundary.
  const now = Date.parse("2026-06-15T14:50:00+10:00");
  const starts = textline.upcomingStarts(grid, schedule.shows, schedule.timezone, now, 15);
  ok(starts.length === 1 && starts[0].showId === "s1", "the 15:00 slot is the one start in the window");
  ok(starts[0].minutes === 10, "and it reports the real minutes remaining");
  ok(/^2026-06-15T15:00$/.test(starts[0].slotKey), "the slot key is station-local date + hour");
  ok(
    textline.upcomingStarts(grid, schedule.shows, schedule.timezone, Date.parse("2026-06-15T15:00:00+10:00"), 15).length === 0,
    "a tick exactly on the hour does not announce a show already starting"
  );

  const reminderSend = sent.length;
  const first = await textline.runReminders({ send, schedule, now });
  ok(first.sent === 1, "the reminder tick sends to the opted-in contact");
  const body = sent[sent.length - 1].body;
  ok(body.includes("https://example.test"), "the reminder carries the station link");
  ok(/Reply STOP/.test(body), "...and the STOP footer");
  ok(sent.length - reminderSend === 1, "exactly one text per tick");

  const second = await textline.runReminders({ send, schedule, now });
  ok(second.sent === 0, "a later tick does not repeat the same showing");
  ok((await prisma.showReminder.count({ where: { contactId: contact!.id } })) === 1, "one claim, not one per tick");

  // ---------------------------------------------------------------- inbound
  const stop = await textline.handleInbound({ phone: "+61408344123", body: "STOP", providerId: "in-1" }, { send, now });
  ok(stop.handled === true, "STOP from a linked phone is handled");
  const afterStop = await prisma.phoneContact.findUnique({ where: { userId: "u1" } });
  ok(!!afterStop?.optedOutAt, "the opt-out is recorded");
  ok((await prisma.showAlert.count({ where: { contactId: contact!.id } })) === 0, "every bell is cleared");
  const confirm = sent[sent.length - 1];
  ok(/unsubscribed/i.test(confirm.body), "a confirmation is sent");
  ok(confirm.opts?.overrideOptout === true, "...using the one-shot override Linq requires");

  const beforeSecond = sent.length;
  const stopAgain = await textline.handleInbound({ phone: "+61408344123", body: "STOP", providerId: "in-2" }, { send, now });
  ok(stopAgain.handled === true, "a second STOP is still handled");
  ok(sent.length === beforeSecond, "but does not send a second confirmation");

  const dup = await textline.handleInbound({ phone: "+61408344123", body: "STOP", providerId: "in-2" }, { send, now });
  ok(dup.handled === true, "a redelivered webhook is a no-op");
  ok((await prisma.textMessage.count({ where: { providerId: "in-2" } })) === 1, "...and cannot duplicate the bubble");

  const request = await textline.handleInbound(
    { phone: "+61408344123", body: "Play some Midnight Oil please", providerId: "in-3" },
    { send, now }
  );
  ok(request.handled === true, "an ordinary request is recorded");
  ok(
    (await prisma.textMessage.count({ where: { providerId: "in-3", direction: "in" } })) === 1,
    "...as an inbound bubble"
  );

  const unknown = await textline.handleInbound({ phone: "+61400000000", body: "hello", providerId: "in-4" }, { send, now });
  ok(unknown.handled === false, "an unknown number is ignored");

  // A bell turned back on is the documented way back from STOP.
  const regrouped = await textline.setShowAlert("u1", "s1", true);
  ok(regrouped.ok === true, "a bell can be re-enabled after STOP");
  ok(
    (await prisma.phoneContact.findUnique({ where: { userId: "u1" } }))!.optedOutAt === null,
    "...which clears the opt-out"
  );
  ok(
    textline.upcomingStarts(grid, schedule.shows, schedule.timezone, now, 15).length === 1,
    "and the scheduler sees the slot again"
  );

  // ---------------------------------------------------------------- unlink
  const before = {
    messages: await prisma.textMessage.count({ where: { contactId: contact!.id } }),
    alerts: await prisma.showAlert.count({ where: { contactId: contact!.id } }),
    reminders: await prisma.showReminder.count({ where: { contactId: contact!.id } }),
  };
  ok(before.messages > 0 && before.alerts > 0 && before.reminders > 0, "there is history to erase");

  const linked = await textline.unlinkPhone("u1");
  ok(linked.ok === true, "unlink succeeds");
  const totals = {
    contacts: await prisma.phoneContact.count(),
    messages: await prisma.textMessage.count(),
    alerts: await prisma.showAlert.count(),
    reminders: await prisma.showReminder.count(),
  };
  ok(
    totals.contacts === 0 && totals.messages === 0 && totals.alerts === 0 && totals.reminders === 0,
    "unlink erases the contact and every row that hangs off it",
    totals
  );
  ok((await textline.phoneStatus("u1")).linked === false, "...and status reports no phone");

  // ---------------------------------------------------------------- webhook
  const secret = "whsec_" + Buffer.from("phone-test-key").toString("base64");
  const payload = JSON.stringify({ event_type: "message.received", data: { id: "x" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const good =
    "v1," +
    crypto
      .createHmac("sha256", Buffer.from("phone-test-key"))
      .update(`evt-1.${ts}.${payload}`)
      .digest("base64");
  ok(
    verifyWebhookSignature(secret, payload, { id: "evt-1", timestamp: ts, signature: good }) === true,
    "a correctly signed webhook verifies"
  );
  ok(
    verifyWebhookSignature(secret, payload + " ", { id: "evt-1", timestamp: ts, signature: good }) === false,
    "a tampered body is refused"
  );
  ok(
    verifyWebhookSignature(
      secret,
      payload,
      { id: "evt-1", timestamp: String(Number(ts) - 3600), signature: good },
      Date.now()
    ) === false,
    "a replayed signature older than five minutes is refused"
  );
  ok(
    verifyWebhookSignature("", payload, { id: "evt-1", timestamp: ts, signature: good }) === false,
    "no secret refuses everything"
  );
} finally {
  await cleanup();
}

console.log(`  ${passed}/${passed + failed} phone-line assertions passed`);
if (failed > 0) process.exit(1);
