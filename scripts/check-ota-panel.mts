// The shared-firmware admin panel: the promises it must keep.
//
// This is a static check, and it is deliberately about SHAPES rather than
// behaviour. The behaviour is covered by check-firmware-ota.mts against a real
// temporary database; what can regress here without any test noticing is the
// admin UI quietly becoming a second install path.
//
// Four rules, in order of how much damage a slip does:
//
//  1. UPLOAD IS NOT PUBLISH. A file that is validated and registered must not be
//     offered to a fleet by the same click, and publish/withdraw must pass
//     through an inline confirmation — not a bare `confirm()` a tired operator
//     can dismiss without reading, and not an immediate request.
//  2. THE ADMIN UI NEVER SERVES FIRMWARE. The image is streamed only to a
//     screen's own accepted attempt over its bearer route. A download link or an
//     artifact URL on this page would be a second, weaker path to the same bytes.
//  3. SUCCESS IS EVIDENCE, NOT OPTIMISM. "active" is not "updated"; a terminal
//     `succeeded` attempt is not either unless the screen also reports running
//     that version. The check pins the version comparison in place.
//  4. THE USB PATH SURVIVES. The per-screen build/flash/upload/rotate/remove
//     controls are how a bricked screen is recovered. Adding OTA must not
//     replace them, and the 90-second stale window must not drift.
//
// Run: npm run check:ota-panel (wired into check:unit).
import { readFileSync } from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${detail}`}`);
}

const REPO = process.cwd();
const read = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const panel = read("app/admin/GlobalFirmwarePanel.tsx");
const screens = read("app/admin/ScreensPanel.tsx");
const devices = read("app/api/admin/devices/route.ts");

/** The body of a top-level `async function NAME` in the panel component. */
function bodyOf(src: string, name: string): string {
  const at = src.indexOf(`async function ${name}`);
  if (at < 0) return "";
  const rest = src.slice(at + `async function ${name}`.length);
  const next = rest.search(/\n  (?:async )?function |\n  const [A-Za-z]/);
  return next < 0 ? rest : rest.slice(0, next);
}

// ------------------------------------------------- 1. mount and separation

{
  ok(/from\s+"\.\/GlobalFirmwarePanel"/.test(screens), "ScreensPanel imports the shared-firmware panel");

  const section = screens.indexOf('id="section-screens"');
  const mount = screens.indexOf("<GlobalFirmwarePanel");
  const addForm = screens.indexOf('id="btn-add-screen"');
  ok(section >= 0, "the screens section still has its id");
  ok(mount > section, "the global panel is mounted inside the screens section");
  ok(addForm > mount, "and above the add-screen form, not after it");

  const upload = bodyOf(panel, "uploadRelease");
  const confirm = bodyOf(panel, "confirmAction");
  ok(upload.length > 0, "the panel has a separate upload handler");
  ok(confirm.length > 0, "and a separate publish/withdraw handler");
  ok(/form\.append\("firmware"/.test(upload) && /form\.append\("version"/.test(upload), "upload sends the image and its version as a form");
  ok(/method:\s*"POST"/.test(upload), "upload is a POST");
  ok(!/method:\s*"PATCH"/.test(upload), "upload does not also publish");
  ok(!/action:\s*["']publish["']/.test(upload), "and it contains no publish action");
  ok(/method:\s*"PATCH"/.test(confirm), "publish/withdraw is a PATCH");
  ok(/action:\s*choice\.kind/.test(confirm), "...that names the action it was confirmed for");
  ok(/JSON\.stringify\(\{\s*action:\s*choice\.kind/.test(confirm), "...and sends { action, releaseId }, not a file");

  ok((panel.match(/"\/api\/admin\/firmware\/ota"/g) ?? []).length >= 3, "the panel reads, uploads and acts through the one admin route");
}

// ------------------------------------------------- 2. explicit confirmation

{
  ok(!/window\.confirm/.test(panel), "the panel never uses window.confirm");
  ok(!/window\.confirm/.test(screens), "nor does the screens panel");
  ok(/setPending\(\{\s*kind:\s*"publish"/.test(panel), "publish arms an inline confirmation");
  ok(/setPending\(\{\s*kind:\s*"withdraw"/.test(panel), "withdraw arms its own inline confirmation");
  ok(/if\s*\(hidden\)\s*setPending\(null\)/.test(panel), "leaving the tab disarms a confirmation that was never used");
  ok(/No screen is offered it until you publish it/.test(panel), "the upload result says registration is not an offer");
  ok(/Being published does not mean every screen has it/.test(panel), "and the published block refuses to imply the fleet caught up");
  ok(/only when someone taps Update firmware/.test(panel), "publishing is described as availability, not installation");
  ok(/targetCount/.test(panel) && /registered screen/.test(panel), "the publish confirmation names how many screens it becomes visible to");
  ok(/bytes already downloaded cannot be recalled/.test(panel), "withdraw says plainly that it cannot undo a download");
}

// ------------------------------------------------- 3. no artifact path here

{
  ok(!/\/api\/devices\/ota/.test(panel) && !/\/api\/devices\/ota/.test(screens), "neither admin file addresses the device artifact stream");
  ok(!/ota\/artifacts/.test(panel) && !/ota\/artifacts/.test(screens), "nor the private artifact directory");
  ok(!/downloadUrl/.test(panel) && !/downloadUrl/.test(screens), "nor a download URL field");
  ok(!/href=\{?[^\n]*sha256/.test(panel), "the hash is rendered as text, not as a link to bytes");
}

// ------------------------------------------------- 4. honest lifecycle UI

{
  ok(/if\s*\(hidden\)\s*return;/.test(panel), "the panel does not fetch while its tab is hidden");
  ok(/cache:\s*"no-store"/.test(panel), "every admin read is uncached");
  ok(/status\s*===\s*404/.test(panel), "a server without the route is reported as unavailable");
  ok(/status\s*===\s*403/.test(panel), "a non-admin is reported as signed out");
  ok(/status\s*===\s*413/.test(panel), "an oversized upload gets its own explanation");
  ok(/NGINX's default 1 MB limit/.test(panel), "...that names the proxy limit a 413 HTML page really comes from");
  ok(/aria-live/.test(panel) && /role="alert"/.test(panel), "status and errors are announced, not just coloured");
  ok(/aria-live="polite"/.test(panel) && /aria-live="assertive"/.test(panel), "with a separate region for the error");
  ok(/PHASE_LABEL\[phase\] \?\?/.test(panel), "an unrecognised attempt phase falls back to a neutral label");
  ok(/unrecognised phase/.test(panel), "and a neutral label is rendered as such");
  ok(/Server-reported state, not live download progress/.test(panel), "active attempts are not dressed up as live progress");

  ok(/overflowWrap:\s*"anywhere"/.test(panel) && /wordBreak:\s*"break-all"/.test(panel), "the full hash wraps instead of forcing the page wide");
  ok(/\{published\.sha256\}/.test(panel), "the published hash is shown in full");
  ok(/shortSha\(/.test(panel), "and a short form is available where the full one is noise");
  ok(/width:\s*"auto"/.test(panel), "inline primary buttons are not forced to full width");
}

// ------------------------------------------------- 5. per-device projection

{
  ok(/otaCapable:\s*d\.otaCapable/.test(devices), "the device list reports OTA capability");
  ok(/otaInstalledVersion:\s*d\.otaInstalledVersion/.test(devices), "and the running release");
  ok(/otaInstalledSha:\s*d\.otaInstalledSha/.test(devices), "and its hash");
  ok(/otaInstalledSlot:\s*d\.otaInstalledSlot/.test(devices), "and which app slot it booted");
  ok(/otaInstalledAt:\s*d\.otaInstalledAt/.test(devices), "and when it was reported");
  ok(/otaAttempt:/.test(devices), "and the latest attempt");

  // Two bounded reads, not a query per row and not the whole history: this list
  // polls every 30 seconds and attempt history only grows.
  ok(/deviceOtaAttempt\.groupBy/.test(devices), "the latest attempts start from an aggregate");
  ok(/_max:\s*\{\s*createdAt:\s*true\s*\}/.test(devices), "...asking only for each device's newest attempt time");
  ok(/OR:\s*attemptPins/.test(devices), "...then one bounded fetch of exactly those rows");
  ok(!/deviceOtaAttempt\.findFirst/.test(devices), "...not one lookup per device");
  ok(!/deviceOtaAttempt\.findMany\(\s*\{\s*where:\s*\{\s*deviceId:\s*\{\s*in/.test(devices),
    "...and never every attempt the fleet has ever made");
  ok(/latestAttempt\.set\(\s*a\.deviceId/.test(devices), "...and grouped in memory");

  // Existing consumers keep every field they had.
  ok(/firmwareVer:\s*d\.firmwareVer/.test(devices), "the factory firmware version is still reported");
  ok(/uploadedBy:\s*d\.uploadedBy\?\.name/.test(devices), "the audit fields are unchanged");
  ok(/skipEnabled:\s*d\.skipEnabled/.test(devices), "the settings projection is unchanged");
  ok(/Cache-Control/.test(devices) && /no-store/.test(devices), "the device list stays uncached");

  // The success claim needs both halves: a terminal attempt AND the version.
  const at = screens.indexOf("function otaSummary");
  const summary = at < 0 ? "" : screens.slice(at, screens.indexOf("\n}", at));
  ok(at >= 0 && summary.length > 0, "the per-screen OTA summary exists");
  ok(/case "succeeded"/.test(summary), "it recognises a succeeded attempt");
  ok(/r\.otaInstalledVersion === attempt\.version/.test(summary), "but only confirms success when the running version matches");
  ok(/not confirmed/.test(summary), "and says so when it does not");
  ok(!/r\.status/.test(summary), "device status is never used as OTA evidence");
  ok(/is its last report, not its current state/.test(summary), "a stale row is described as a last report");
  ok(/Retry from the screen's Settings/.test(summary), "a failure points at the screen's own retry");
}

// ------------------------------------------------- 6. the USB path survives

{
  for (const control of [
    "Get build command",
    "Upload firmware",
    "Reset credentials",
    "btn-flash-",
    "btn-build-",
    "btn-rotate-",
    "btn-remove-",
    "esp-web-install-button",
    "esp-web-tools",
  ]) {
    ok(screens.includes(control), `the USB control "${control}" is preserved`);
  }
  ok(/>\s*90_000/.test(screens) || />90_000/.test(screens), "the 90-second stale window is unchanged");
  ok(/id="section-screens"/.test(screens), "the section keeps the id the admin page targets");
}

// ------------------------------------------------- the checker checks itself

{
  const bannedWindowConfirm = 'window.confirm("Publish 1.15.0?")';
  ok(/window\.confirm/.test(bannedWindowConfirm), "MUTATION CAUGHT: a native confirm is the shape this check bans");
  ok(!/window\.confirm/.test(panel), "MUTATION SANITY: the real panel contains none");

  const bannedArtifact = 'fetch("/api/devices/ota")';
  ok(/\/api\/devices\/ota/.test(bannedArtifact), "MUTATION CAUGHT: an artifact path is the shape this check bans");
  ok(!/\/api\/devices\/ota/.test(panel), "MUTATION SANITY: the real panel contains none");

  const bannedSuccess = "if (r.status === \"active\") return true;";
  ok(/r\.status/.test(bannedSuccess), "MUTATION CAUGHT: status-only success is the shape this check bans");

  const uploadStub = 'const form = new FormData(); form.append("firmware", f); await fetch("/api/admin/firmware/ota", { method: "POST" });';
  ok(/method:\s*"POST"/.test(uploadStub) && !/PATCH/.test(uploadStub), "MUTATION CAUGHT: an upload that is only a POST is correctly read as separate from publish");
}

console.log(`  ${passed}/${passed + failed} shared-firmware admin-panel assertions passed`);
if (failed > 0) process.exit(1);
