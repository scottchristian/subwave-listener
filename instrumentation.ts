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

  try {
    // Same reasoning: a skill run outlives the request that asked for it, so the
    // executor has to live somewhere longer-lived than a route handler.
    const { startSkillWorker } = await import("./lib/skillrunner");
    await startSkillWorker();
  } catch (err) {
    console.warn("[boot] skill worker not started:", message(err));
  }
}

const message = (err: unknown) =>
  err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
