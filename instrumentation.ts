// Runs once per server start, in the Node runtime. This is the only place a
// long-lived timer can live in Next: a route handler is rebuilt per request,
// so a keep-alive started from one would die with it.
//
// EVERY START IS DEFENSIVE. On a brand-new install there is no database yet,
// and the setup wizard exists precisely so the app can boot before one is
// configured. `lib/prisma` constructs a PrismaClient at module scope, and Prisma
// throws when DATABASE_URL is missing — so merely importing the skill runner
// would take the whole process down, and the wizard would have no page to render.
//
// A failure here means a background nicety is unavailable. It must never mean the
// app will not boot.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // FIRST, before anything that might fail: an install that was set up before
  // the wizard existed has no marker file, and without this the upgrade would
  // publish an unauthenticated page that rewrites the station's Google
  // credentials. A configured station closes its own wizard.
  try {
    const { adoptIfAlreadyConfigured } = await import("./lib/setup");
    adoptIfAlreadyConfigured();
  } catch (err) {
    console.error("[boot] could not evaluate setup state:", message(err));
  }

  try {
    const { start } = await import("./lib/dbkeepalive");
    start();
  } catch (err) {
    console.warn("[boot] database keep-alive not started:", message(err));
  }

  // A hibernated database wakes on traffic, slowly. Start knocking now so a
  // station rebooted against a sleeping database is already awake by the
  // time the first listener arrives — fire-and-forget, never blocks boot.
  try {
    const { wakeDbInBackground } = await import("./lib/dbwake");
    wakeDbInBackground();
  } catch (err) {
    console.warn("[boot] database wake loop not started:", message(err));
  }

  try {
    // Same reasoning: a skill run outlives the request that asked for it, so the
    // executor has to live somewhere longer-lived than a route handler.
    const { startSkillWorker } = await import("./lib/skillrunner");
    await startSkillWorker();
  } catch (err) {
    console.warn("[boot] skill worker not started:", message(err));
  }

  try {
    // One tick a minute: automatic updates inside the operator's window, and
    // nothing else. Reads settings fresh each tick so a change applies without
    // a restart; fails closed on anything unreadable.
    const { startAutoUpdateScheduler } = await import("./lib/auto-update");
    startAutoUpdateScheduler();
  } catch (err) {
    console.warn("[boot] auto-update scheduler not started:", message(err));
  }
}

const message = (err: unknown) =>
  err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
