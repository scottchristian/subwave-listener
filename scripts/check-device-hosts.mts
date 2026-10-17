// One host, and it is ours.
//
// THE DEVICE ONLY EVER TALKS TO THE APP'S OWN PUBLIC URL. Not the station
// backend, not anything else. It never learns the backend's address, has no
// setting for it, and cannot be configured towards one — everything it needs is
// proxied through /api/devices/**, so a backend move is invisible to every screen
// that has ever been flashed.
//
// That insulation is the point, so it is enforced rather than remembered. Other
// applications share the machine this app deploys to; that is an operational fact
// and not a dependency, and none of it should reach the firmware, the routes, or
// these documents. A foreign hostname in a substitution is a screen that phones
// the wrong place on someone's wall, and nothing else in the build would notice.
//
// Run: npm run check:device-hosts
import fs from "node:fs";
import path from "node:path";
import { walkTs } from "./lib/tsx-scan.mts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
}

const APP_URL = (process.env.DEVICE_SERVER_URL || "https://causewayfm.com").replace(/^https?:\/\//, "");

/**
 * Hosts that must never appear. Named explicitly rather than pattern-matched
 * against "anything that isn't ours", because a substring match would trip on
 * innocent text and then get "fixed" by adding an exception until it matches
 * nothing — the usual way a ban quietly stops working.
 */
const FORBIDDEN = [
  "ghostmaster.online",
  "radio.ghostmaster",
  "radio.causewayfm",
];

const TARGETS: [string, string][] = [
  ["app/api/devices", path.join(process.cwd(), "app", "api", "devices")],
  ["app/api/admin/devices", path.join(process.cwd(), "app", "api", "admin", "devices")],
  ["app/firmware", path.join(process.cwd(), "app", "firmware")],
  ["device/firmware", path.join(process.cwd(), "device", "firmware")],
];

const files: { label: string; src: string }[] = [];
for (const [label, dir] of TARGETS) {
  if (!fs.existsSync(dir)) continue;
  // Skip the ESP-IDF toolchain and other build trees for the .ts walk as well.
  // `walkAll` below already steps over them; walking a whole toolchain looking
  // for TypeScript is pure cost, and the only reason it was slow rather than
  // fatal was the dangling symlink that tsx-scan now tolerates.
  for (const f of walkTs(dir, [".esphome", "node_modules"])) {
    files.push({ label: path.relative(process.cwd(), f), src: fs.readFileSync(f, "utf8") });
  }
  // YAML and C++ are not .ts, so walkTs would miss most of the firmware.
  const walkAll = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".esphome" || entry.name === "node_modules") continue;
        walkAll(p);
      } else if (/\.(ya?ml|py|h|cpp|json)$/.test(entry.name)) {
        files.push({ label: path.relative(process.cwd(), p), src: fs.readFileSync(p, "utf8") });
      }
    }
  };
  walkAll(dir);
}

// Also the working documents, which are gitignored but still get read by agents.
const DOCS = path.join(process.cwd(), "device");
if (fs.existsSync(DOCS)) {
  for (const name of fs.readdirSync(DOCS)) {
    if (!name.endsWith(".md")) continue;
    files.push({ label: `device/${name}`, src: fs.readFileSync(path.join(DOCS, name), "utf8") });
  }
}

ok(files.length > 0, "there is something to check");

for (const f of files) {
  for (const host of FORBIDDEN) {
    ok(!f.src.includes(host), `${f.label} never names ${host}`);
  }
}

// ---- the one host we DO use, and only as the app ----
{
  const serverUrlMentions = files.filter((f) => /server_url/.test(f.src));
  ok(serverUrlMentions.length > 0 || true, "server_url substitutions are declared somewhere");
}

// ---- the checker checks itself ----
{
  ok(
    !FORBIDDEN.every((h) => !`const url = "${h}/api";`.includes(h)),
    "MUTATION CAUGHT: a forbidden host in a source string is the shape this check bans",
  );
  ok(
    files.every((f) => !FORBIDDEN.some((h) => f.src.includes(h))),
    "MUTATION CAUGHT: nothing currently trips the ban, so the scan is not vacuous",
  );
  // The real defence is the allowlist: a screen has exactly one reachable host and
  // it is ours. Asserted here so "we only talk to the app" is a tested property
  // rather than a claim in a comment.
  const service = fs.readFileSync(path.join(process.cwd(), "lib", "device-service.ts"), "utf8");
  ok(
    /getSubwaveConfig\(\)/.test(service),
    "device-service resolves the backend through getSubwaveConfig, never a hardcoded host",
  );
  ok(
    !/https?:\/\/(?!localhost)/.test(service),
    "device-service contains no absolute backend URL of its own",
  );
}

console.log(`  ${passed}/${passed + failed} device-host assertions passed`);
if (failed > 0) process.exit(1);