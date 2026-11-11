// Station identity fallbacks and Sub/Wave config assembly.
//
// Two modules that read the environment and quietly substitute a placeholder
// when it is missing. That is deliberate — a fresh install has to boot — but it
// is also how a station ends up broadcasting as "Community Radio" with a
// backend URL pointing nowhere, and neither is visible until a listener
// complains.
//
// The URL assembly has a specific history worth pinning: Caddy forwards only
// /api/*, so a missing or doubled /api suffix 404s into the web UI rather than
// failing as a config error.
//
// Run: npm run check:station
const saved = { ...process.env };
for (const k of [
  "NEXT_PUBLIC_STATION_NAME",
  "NEXT_PUBLIC_STATION_TAGLINE",
  "NEXT_PUBLIC_STATION_DESCRIPTION",
  "NEXT_PUBLIC_STATION_ABOUT",
  "NEXT_PUBLIC_STATION_LOGO",
  "NEXT_PUBLIC_BACKEND_URL",
  "NEXT_PUBLIC_DONATE_URL",
  "SUBWAVE_API_URL",
  "SUBWAVE_ADMIN_USER",
  "SUBWAVE_ADMIN_PASS",
]) {
  delete process.env[k];
}

const station = await import(`../lib/station.ts?fresh=${Date.now()}`);

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

// ---- every field falls back, and no fallback is another station's name ----
ok(station.STATION.name === "Community Radio", "an unset name falls back");
ok(station.STATION.tagline.length > 0, "an unset tagline falls back");
ok(station.STATION.description.length > 0, "an unset description falls back");
ok(station.STATION.about.length > 0, "an unset about falls back");
ok(station.STATION.logo === "/brand/logo.png", "an unset logo points at the stable branding route");
ok(station.STATION.backendUrl === "", "an unset backend is empty, not a made-up host");
ok(station.STATION.donateUrl === "", "an unset donate url is empty");
// A neutral placeholder must never look like a real configured station.
ok(!/causeway|ghostmaster/i.test(Object.values(station.STATION).join(" ")), "no fallback mentions a real station");

// ---- whitespace-only values count as unset, and values are trimmed ----
{
  process.env.NEXT_PUBLIC_STATION_NAME = "   ";
  const blank = await import(`../lib/station.ts?blank=${Date.now()}`);
  ok(blank.STATION.name === "Community Radio", "a whitespace-only name is treated as unset");

  process.env.NEXT_PUBLIC_STATION_NAME = "  Subwave Test  ";
  const padded = await import(`../lib/station.ts?padded=${Date.now()}`);
  ok(padded.STATION.name === "Subwave Test", "a padded name is trimmed");

  process.env.NEXT_PUBLIC_STATION_LOGO = "   ";
  const logo = await import(`../lib/station.ts?logo=${Date.now()}`);
  ok(logo.STATION.logo === "/brand/logo.png", "a whitespace-only logo is treated as unset");
  delete process.env.NEXT_PUBLIC_STATION_NAME;
  delete process.env.NEXT_PUBLIC_STATION_LOGO;
}

// ---- the load-bearing warning: NEXT_PUBLIC_* must be read literally ----
// Next inlines process.env.NEXT_PUBLIC_X by static analysis. A helper with a
// variable key is not replaced, so the client silently ships the placeholder.
// This asserts the source still spells each key out, because the failure it
// prevents is invisible in every other test here.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/station.ts", import.meta.url), "utf8");
  for (const key of [
    "NEXT_PUBLIC_STATION_NAME",
    "NEXT_PUBLIC_STATION_TAGLINE",
    "NEXT_PUBLIC_STATION_DESCRIPTION",
    "NEXT_PUBLIC_STATION_ABOUT",
    "NEXT_PUBLIC_STATION_LOGO",
    "NEXT_PUBLIC_BACKEND_URL",
    "NEXT_PUBLIC_DONATE_URL",
  ]) {
    ok(src.includes(`process.env.${key}`), `${key} is read as a literal, so Next can inline it`);
  }
  // The comment warning about this hazard mentions the pattern, so strip
  // comments before looking for a real variable-key lookup in code.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok(!/process\.env\[/.test(codeOnly), "no variable-key env lookup sneaks in");
}

console.log(`  ${passed}/${passed + failed} station assertions passed`);
Object.assign(process.env, saved);
if (failed > 0) process.exit(1);
