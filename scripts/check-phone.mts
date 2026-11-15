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
  const { normalizePhone, dialCodeForTimezone, isOptOut, formatPhoneInput, formatIntlPhone, textLink } =
    await import("../lib/phone.ts");
  const { dialForCountry, isKnownDialCode, isoForDial } = await import("../lib/countries.ts");
  const { verifyWebhookSignature, stationTextNumber, sendText } = await import("../lib/linq.ts");
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

  ok(dialForCountry("AU") === "+61" && dialForCountry("nz") === "+64", "the country picker maps regions to dial codes");
  ok(dialForCountry("ZZ") === null, "a region the picker never offered is refused");
  ok(isKnownDialCode("+61") && !isKnownDialCode("+999"), "only offered dial codes are known");
  ok(isoForDial("+61") === "AU" && isoForDial("+64") === "NZ", "a dial code maps back to a region for formatting");
  ok(isoForDial("+1") === "US", "a shared dial code maps to its main region");
  ok(isoForDial("") === null, "no dial code means no formatting guess");

  ok(isOptOut("STOP") && isOptOut("UNSUBSCRIBE") && isOptOut("QUIT"), "standard opt-out words are honoured");
  ok(isOptOut("OPT OUT") && isOptOut("opt-out") && isOptOut(" Opt  Out "), "OPT OUT tolerates casing and spacing");
  ok(
    isOptOut("stop texting me") && isOptOut("Please stop messaging me.") && isOptOut("Don't text me"),
    "a clear stop request is honoured even without the keyword"
  );
  ok(!isOptOut("stop texting me the playlist"), "...but only when the whole message is the request");
  ok(!isOptOut("stop"), "lower-case stop is a song named stop, not an opt-out");
  ok(!isOptOut("please STOP the music"), "opt-out is the whole message, not a word in one");

  // ----------------------------------------------------------- formatting
  ok(formatPhoneInput("0408826585", "AU") === "0408 826 585", "an Australian mobile groups 4-3-3");
  ok(formatPhoneInput("0408 826 585", "AU") === "0408 826 585", "re-formatting is idempotent");
  ok(formatPhoneInput("04086", "AU") === "0408 6", "a partial number groups as far as it goes");
  ok(formatPhoneInput("(04) 0834-4123", "AU") === "0408 344 123", "punctuation is replaced by spaces");
  ok(formatPhoneInput("408826585", "AU") === "408 826 585", "a number without the trunk zero is still grouped");
  ok(formatPhoneInput("4088265855", "US") === "(408) 826-5855", "a US number groups in its own shape");
  ok(formatPhoneInput("07911123456", "GB") === "07911 123456", "a UK number groups 5-6");
  ok(formatPhoneInput("021555123", "NZ") === "021 555 123", "a New Zealand mobile groups 3-3-3");
  ok(formatPhoneInput("+1 408 826 5855", "AU") === "+1 408 826 5855", "another country's number is never rearranged");
  ok(formatPhoneInput("+61 408 826 585", "AU") === "+61 408 826 585", "an international number is formatted as international");
  ok(formatPhoneInput("", "AU") === "" && formatPhoneInput("+", "AU") === "+", "empty and lone plus survive");
  ok(normalizePhone(formatPhoneInput("0408826585", "AU"), "+61") === "+61408826585", "the formatted value still normalizes — spaces are ignored");
  ok(normalizePhone(formatPhoneInput("021555123", "NZ"), "+64") === "+6421555123", "a picked country's number round-trips to E.164");

  ok(formatIntlPhone("+12055030476") === "+1 205 503 0476", "the station line is shown in international shape");
  ok(
    textLink("+12055030476") === "sms:+12055030476?&body=Hi",
    "the text link addresses the station with a prefilled body on iOS and Android"
  );
  ok(
    textLink("+12055030476", "Hi there") === "sms:+12055030476?&body=Hi%20there",
    "...and encodes spaces for every messaging app"
  );
  ok(textLink("") === "" && textLink("123") === "", "no usable number means no link");

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

  // Step one only remembers the number. The bind code is a reply to the
  // listener's text, so nothing is sent until that text arrives.
  const invalid = await textline.beginLink("u1", "hello", { defaultCountry: "+61" });
  ok(invalid.ok === false && invalid.code === "invalid_phone", "a number that cannot be parsed is refused");

  const began = await textline.beginLink("u1", "0408 344 123", { defaultCountry: "+61" });
  ok(began.ok === true, "entering a number starts the link");
  ok(sent.length === 0, "...without texting anything yet");
  const awaiting = await prisma.phoneVerification.findUnique({ where: { userId: "u1" } });
  ok(
    !!awaiting && awaiting.phone === "+61408344123" && awaiting.codeHash === "",
    "the pending row carries the E.164 number and no code yet"
  );
  const waitingStatus = await textline.phoneStatus("u1");
  ok(waitingStatus.awaitingText && !waitingStatus.codeSentAt, "status says the link is waiting for its text");

  // One waiting link per number: a second account cannot arm the same phone.
  await prisma.user.create({ data: { id: "u2" } });
  const stolen = await textline.beginLink("u2", "0408 344 123", { defaultCountry: "+61" });
  ok(stolen.ok === false && stolen.code === "phone_taken", "a number another account is already linking is refused");

  // Only a text from the entered number releases the code.
  await textline.handleInbound({ phone: "+61400000000", body: "Hi", providerId: "bind-other" }, { send });
  ok(sent.length === 0, "a text from another number gets no code");
  await textline.handleInbound({ phone: "+61408344123", body: "STOP", providerId: "bind-stop" }, { send });
  ok(sent.length === 0, "STOP from a waiting number is not treated as a bind request");
  ok(
    (await prisma.phoneVerification.findUnique({ where: { userId: "u1" } }))!.codeHash === "",
    "...and leaves the link waiting"
  );

  const inbound = await textline.handleInbound({ phone: "+61408344123", body: "Hi", providerId: "bind-1" }, { send });
  ok(inbound.handled === true, "the waiting number's text is handled");
  ok(sent.length === 1 && sent[0].to === "+61408344123", "the station texts the bind code back to that number");
  const code = String(sent[sent.length - 1].body.match(/\b(\d{6})\b/)?.[1] || "");
  ok(/^\d{6}$/.test(code), "the code is six digits in the message");
  const pending = await prisma.phoneVerification.findUnique({ where: { userId: "u1" } });
  ok(
    !!pending && pending.phone === "+61408344123" && !pending.codeHash.includes(code),
    "the code is stored as a hash, never in the clear"
  );
  const codeStatus = await textline.phoneStatus("u1");
  ok(codeStatus.codeSentAt !== null && !codeStatus.awaitingText, "status moves the panel to the code step");

  await textline.handleInbound({ phone: "+61408344123", body: "did that work?", providerId: "bind-2" }, { send });
  ok(sent.length === 1, "a second text does not send a second code");

  await textline.handleInbound({ phone: "+61408344123", body: "Hi", providerId: "bind-1" }, { send });
  ok(sent.length === 1, "a redelivered text cannot send another code");

  // A failed code send leaves the number armed, so the next text retries.
  await prisma.user.create({ data: { id: "u4" } });
  const armed = await textline.beginLink("u4", "0408 555 123", { defaultCountry: "+61" });
  ok(armed.ok === true, "another number can wait for its text");
  failNext = "send failed (403 2008)";
  const failed = await textline.handleInbound({ phone: "+61408555123", body: "Hi", providerId: "bind-fail" }, { send });
  ok(failed.handled === true && sent.length === 1, "a failed code send sends nothing");
  ok(
    (await prisma.phoneVerification.findUnique({ where: { userId: "u4" } }))!.codeHash === "",
    "...and leaves the link waiting"
  );
  await textline.handleInbound({ phone: "+61408555123", body: "Hi again", providerId: "bind-fail-2" }, { send });
  ok(sent.length === 2, "...so the next text sends the code");

  // Resend: the panel's button after ten seconds, and the server's own gate.
  await prisma.user.create({ data: { id: "u5" } });
  await textline.beginLink("u5", "0408 777 123", { defaultCountry: "+61" });
  await textline.handleInbound({ phone: "+61408777123", body: "Hi", providerId: "resend-1" }, { send });
  const firstCode = String(sent[sent.length - 1].body.match(/\b(\d{6})\b/)?.[1] || "");
  const beforeResend = sent.length;
  const tooSoon = await textline.resendLinkCode("u5", { send });
  ok(tooSoon.ok === false && tooSoon.code === "too_soon", "a resend inside ten seconds is refused");
  ok(sent.length === beforeResend, "...and sends nothing");
  const resent = await textline.resendLinkCode("u5", { send, now: Date.now() + textline.RESEND_WAIT_MS });
  ok(resent.ok === true && sent.length === beforeResend + 1, "after ten seconds a new code is sent");
  const secondCode = String(sent[sent.length - 1].body.match(/\b(\d{6})\b/)?.[1] || "");
  const stale = await textline.verifyLink("u5", firstCode, { send });
  ok(stale.ok === false, "the previous code stops working once a new one is sent");

  failNext = "send failed (503)";
  const failedResend = await textline.resendLinkCode("u5", { send, now: Date.now() + textline.RESEND_WAIT_MS * 2 });
  ok(failedResend.ok === false && failedResend.code === "send_failed", "a failed resend is reported");
  ok((await textline.phoneStatus("u5")).codeSentAt !== null, "...and the previous code stays live");
  const verifiedResend = await textline.verifyLink("u5", secondCode, { send });
  ok(verifiedResend.ok === true, "the code from the successful resend links the phone");
  await textline.unlinkPhone("u5");

  await prisma.user.create({ data: { id: "u6" } });
  await textline.beginLink("u6", "0408 666 123", { defaultCountry: "+61" });
  const armedCount = sent.length;
  const noCodeYet = await textline.resendLinkCode("u6", { send });
  ok(noCodeYet.ok === false && noCodeYet.code === "awaiting_text", "a resend before any code is sent asks for the text instead");
  ok(sent.length === armedCount, "...without sending");
  const expiredResend = await textline.resendLinkCode("u6", { send, now: Date.now() + textline.AWAIT_TEXT_MS + 1000 });
  ok(expiredResend.ok === false && expiredResend.code === "expired", "an expired link cannot resend");
  ok((await prisma.phoneVerification.findUnique({ where: { userId: "u6" } })) === null, "...and its pending row is gone");

  // A listener who picks another country keeps that country's code: the
  // station's timezone is only the default, not the rule.
  await prisma.user.create({ data: { id: "u3" } });
  const usStart = await textline.beginLink("u3", "408 826 5855", { defaultCountry: "+1" });
  ok(usStart.ok === true, "a number under a picked country starts its link");
  ok(
    (await prisma.phoneVerification.findUnique({ where: { userId: "u3" } }))!.phone === "+14088265855",
    "...and is stored with that country's code, not the station's"
  );

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

  const relink = await textline.beginLink("u1", "0408 344 123", { defaultCountry: "+61" });
  ok(relink.ok === false && relink.code === "already_linked", "a linked account cannot start another link");
  const taken = await textline.beginLink("u4", "0408 344 123", { defaultCountry: "+61" });
  ok(taken.ok === false && taken.code === "phone_taken", "a number linked to another account is refused");

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

  const beforeRequest = sent.length;
  const request = await textline.handleInbound(
    { phone: "+61408344123", body: "Play some Midnight Oil please", providerId: "in-3" },
    { send, now, listeners: async () => 0 }
  );
  ok(request.handled === true, "an ordinary request is recorded");
  ok(
    (await prisma.textMessage.count({ where: { providerId: "in-3", direction: "in" } })) === 1,
    "...as an inbound bubble"
  );
  ok(sent.length === beforeRequest, "an opted-out contact gets no offline reply");

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

  // Linq can mark a chat OPTED_OUT without our keyword matching. That is the
  // carrier's STOP too: record it, drop the bells, and send no second courtesy.
  const beforeHealth = sent.length;
  const health = await textline.handleInbound(
    { phone: "+61408344123", body: "still there?", providerId: "in-health", chatHealth: "OPTED_OUT" },
    { send, now }
  );
  ok(
    health.handled === true && sent.length === beforeHealth,
    "an OPTED_OUT chat health is recorded without another text"
  );
  ok(
    !!(await prisma.phoneContact.findUnique({ where: { userId: "u1" } }))!.optedOutAt,
    "...and marks the contact opted out"
  );
  ok((await prisma.showAlert.count({ where: { contactId: contact!.id } })) === 0, "...and clears the bells");
  await textline.setShowAlert("u1", "s1", true);

  // ------------------------------------------------------------ offline line
  // Nobody on air: a request would go unheard, so reply once with "not online".
  const beforeOffline = sent.length;
  const offline = await textline.handleInbound(
    { phone: "+61408344123", body: "Can you play something by The Cure?", providerId: "in-off-1" },
    { send, now, listeners: async () => 0 }
  );
  ok(offline.handled === true, "a text while the station is not online is handled");
  ok(
    sent.length === beforeOffline + 1 && sent[sent.length - 1].body === textline.OFFLINE_REPLY,
    "...and answers once with the offline reply"
  );
  ok(
    /isn't online/i.test(textline.OFFLINE_REPLY) && /come back later/i.test(textline.OFFLINE_REPLY),
    "the reply says the station is not online and to come back later"
  );
  ok(
    (await prisma.textMessage.count({ where: { contactId: contact!.id, direction: "out", body: textline.OFFLINE_REPLY } })) === 1,
    "...recorded in the thread"
  );

  const beforeBurst = sent.length;
  await textline.handleInbound(
    { phone: "+61408344123", body: "hello?", providerId: "in-off-2" },
    { send, now: now + 5 * 60 * 1000, listeners: async () => 0 }
  );
  ok(sent.length === beforeBurst, "a second text within the hour does not text again");

  await textline.handleInbound(
    { phone: "+61408344123", body: "hello?", providerId: "in-off-3" },
    { send, now: now + textline.OFFLINE_REPLY_MS + 60_000, listeners: async () => 0 }
  );
  ok(sent.length === beforeBurst + 1, "after an hour the offline reply is allowed again");

  const beforeOnAir = sent.length;
  await textline.handleInbound(
    { phone: "+61408344123", body: "Play The Cure", providerId: "in-on-1" },
    { send, now, listeners: async () => 3 }
  );
  ok(sent.length === beforeOnAir, "with listeners on air a request gets no offline reply");

  await textline.handleInbound(
    { phone: "+61408344123", body: "Play The Cure", providerId: "in-on-2" },
    { send, now, listeners: async () => null }
  );
  ok(sent.length === beforeOnAir, "an unreadable listener count never claims the station is down");

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

  // ---------------------------------------------------------- station number
  // Onboarding is inbound-first, so a policy refusal should name the line the
  // listener can text. The lookup is cached: it is not a per-send call.
  process.env.LINQ_ENABLED = "true";
  process.env.LINQ_API_KEY = "test-api-key";
  const lookups: string[] = [];
  const numberFetch: any = async (url: string) => {
    lookups.push(String(url));
    return { ok: true, json: async () => ({ phone_number: "+61400111222" }) };
  };
  const tn = Date.now();
  ok(
    (await stationTextNumber({ fetchImpl: numberFetch, now: tn })) === "+61400111222",
    "the station's own line is read from Linq"
  );
  ok(
    (await stationTextNumber({ fetchImpl: numberFetch, now: tn + 1000 })) === "+61400111222" && lookups.length === 1,
    "...and reused instead of looked up again"
  );

  const deadFetch: any = async () => ({ ok: false, json: async () => ({}) });
  ok(
    (await stationTextNumber({ fetchImpl: deadFetch, now: tn + 11 * 60 * 1000 })) === null,
    "a failed lookup is null, never a broken message"
  );

  const wire: { headers: any; body: any }[] = [];
  const capture: any = async (_url: string, init: any) => {
    wire.push({ headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, text: async () => JSON.stringify({ chat_id: "c9", message: { id: "m9" } }) };
  };
  const sentOne = await sendText("+61400111222", "hello", {
    idempotencyKey: "reminder-c1-2026-06-15T15:00",
    overrideOptout: true,
    fetchImpl: capture,
  });
  ok(sentOne.ok === true, "a send succeeds against the capture");
  ok(
    wire[0].body.message.idempotency_key === "reminder-c1-2026-06-15T15:00",
    "the idempotency key rides inside the message body"
  );
  ok(!wire[0].headers["Idempotency-Key"], "...not as an HTTP header Linq ignores");
  ok(wire[0].body.override_optout === true, "the one-shot opt-out override stays top-level");

  const refusedFetch: any = async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ code: "2015", trace_id: "trace_abc123" }),
  });
  const refusedSend = await sendText("+61400111222", "hello", { fetchImpl: refusedFetch });
  ok(
    refusedSend.ok === false && refusedSend.error === "send failed (409 2015)" &&
      refusedSend.traceId === "trace_abc123",
    "a failed send keeps Linq's trace id for support"
  );

  delete process.env.LINQ_ENABLED;
  delete process.env.LINQ_API_KEY;
} finally {
  await cleanup();
}

console.log(`  ${passed}/${passed + failed} phone-line assertions passed`);
if (failed > 0) process.exit(1);
