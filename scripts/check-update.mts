// Updater unit tests: everything that can run without network, npm or pm2.
// Version gating, tarball URLs, the source swap/prune file ops, the job file,
// and the step runner. The orchestration (download → swap → install → build →
// restart) is exercised by hand against a scratch station, not here — running a
// real build inside `npm run check` would take minutes and could restart pm2.
import { promises as fs, createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";

const update = await import("../lib/update.ts");
// update-run pulls next-auth and the prisma client at module load; neither is
// touched by the tests below (no DB, no session), they just have to import.
const runLib = await import("../lib/update-run.ts");

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
function throws(fn: () => void, name: string) {
  try {
    fn();
    ok(false, name, "did not throw");
  } catch {
    ok(true, name);
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-update-test-"));
try {
  // ---- target parsing: only exact versions can become a fetch ----
  ok(update.parseUpdateTarget("v0.0.3") === "0.0.3", "v prefix stripped");
  ok(update.parseUpdateTarget("0.0.3") === "0.0.3", "bare version");
  ok(update.parseUpdateTarget("  v1.2.3  ") === "1.2.3", "whitespace trimmed");
  ok(update.parseUpdateTarget("0.1.0-beta.1") === "0.1.0-beta.1", "prerelease shape parses");
  for (const bad of ["main", "", "https://evil/x.tar.gz", "../escape", "v1", "1.2", "1.2.3.4", "v", "latest"]) {
    throws(() => update.parseUpdateTarget(bad), `rejects ${JSON.stringify(bad)}`);
  }

  // ---- upgrade gating ----
  throws(() => update.assertUpgradeAllowed("0.0.2", "0.0.2", false), "same version refused");
  throws(() => update.assertUpgradeAllowed("0.0.1", "0.0.2", false), "downgrade refused");
  throws(() => update.assertUpgradeAllowed("0.0.10", "0.0.9", true), "prerelease refused even when newer");
  update.assertUpgradeAllowed("0.0.10", "0.0.9", false);
  ok(true, "newer stable allowed");

  // ---- tarball URL is always our repo, always a tag ----
  const url = update.releaseTarballUrl("0.0.3");
  ok(
    url === "https://github.com/scottchristian/subwave-listener/archive/refs/tags/v0.0.3.tar.gz",
    "tarball URL shape",
    url
  );
  ok(update.releaseTarballUrl("v0.0.3") === url, "v prefix normalized, not doubled");

  // ---- source snapshot + prune on fixture trees ----
  const live = path.join(tmp, "live");
  const staged = path.join(tmp, "staged");
  const snap = path.join(tmp, "snap");
  const write = async (base: string, rel: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
    await fs.writeFile(path.join(base, rel), content);
  };
  await write(live, "app/page.tsx", "v1 page");
  await write(live, "app/old-route/route.ts", "removed upstream");
  await write(live, ".env.local", "SECRET=live");
  await write(live, "data/backups/b.json", "{}");
  await write(live, "node_modules/dep/index.js", "dep");
  await write(live, ".next/BUILD_ID", "old");
  await write(live, ".git/HEAD", "ref");
  await write(staged, "app/page.tsx", "v2 page");
  await write(staged, "app/new/route.ts", "new file");
  await write(staged, "package-lock.json", "{}");

  const copied = await update.copySourceTree(live, snap);
  ok(copied === 2, "snapshot copies source files only", `got ${copied}`);
  ok((await fs.readFile(path.join(snap, "app/page.tsx"), "utf8")) === "v1 page", "snapshot content intact");
  for (const p of [".env.local", "data", "node_modules", ".git", ".next"]) {
    ok(!(await fs.stat(path.join(snap, p)).catch(() => null)), `snapshot excludes ${p}`);
  }

  // Swap staged over live the way the updater does: copy over, then prune stale.
  await update.copySourceTree(staged, live);
  const pruned = await update.pruneStaleFiles(live, staged);
  ok((await fs.readFile(path.join(live, "app/page.tsx"), "utf8")) === "v2 page", "staged overwrites live");
  ok(!(await fs.stat(path.join(live, "app/old-route/route.ts")).catch(() => null)), "renamed route pruned");
  ok(pruned === 1, "prune count", `got ${pruned}`);
  for (const [p, want] of [[".env.local", "SECRET=live"], ["data/backups/b.json", "{}"]] as const) {
    ok((await fs.readFile(path.join(live, p), "utf8")) === want, `protected ${p} untouched`);
  }

  // ---- lockfile comparison ----
  ok((await update.lockfileChanged(live, staged)) === false, "identical (both missing) lockfiles install to be safe");
  await write(live, "package-lock.json", '{"v":1}');
  ok((await update.lockfileChanged(live, staged)) === true, "different lockfiles detected");
  await write(staged, "package-lock.json", '{"v":1}');
  ok((await update.lockfileChanged(live, staged)) === false, "identical lockfiles skip install");

  // ---- job file round-trip ----
  const jobDir = path.join(tmp, "jobapp", "data");
  await fs.mkdir(jobDir, { recursive: true });
  const appDir = path.join(tmp, "jobapp");
  ok((await update.readJob(appDir)) === null, "missing job reads null");
  await fs.writeFile(path.join(jobDir, "update-job.json"), "not json");
  ok((await update.readJob(appDir)) === null, "corrupt job reads null");
  const now = new Date().toISOString();
  await update.writeJob(appDir, {
    status: "running", from: "0.0.2", to: "0.0.3", backupId: "b1",
    startedAt: now, updatedAt: now, log: ["a"],
  });
  const job = await update.readJob(appDir);
  ok(job !== null && job.status === "running" && job.to === "0.0.3", "job round-trips");
  ok(update.jobRunning(job), "fresh running job owns the updater");
  ok(!update.jobRunning({ ...job!, updatedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }), "stale running job released");
  ok(!update.jobRunning({ ...job!, status: "done" }), "finished job does not block");
  const mode = (await fs.stat(path.join(jobDir, "update-job.json"))).mode & 0o777;
  ok(mode === 0o600, "job file is 0600", mode.toString(8));

  // ---- preflight: read-only probes, safe anywhere ----
  {
    const pre = await runLib.preflight(tmp);
    ok(pre.diskOk === true, "disk floor passes on a dev machine");
    ok(pre.tar === true, "tar found");
    ok(pre.npm !== null, "npm resolved");
    ok(typeof pre.diskBytes === "number" && pre.diskBytes > 0, "disk bytes positive");
  }

  // ---- download + tarball validation against a localhost server ----
  {
    const { createServer } = await import("node:http");
    const goodDir = path.join(tmp, "rel-v9");
    await fs.mkdir(path.join(goodDir, "app"), { recursive: true });
    await fs.writeFile(path.join(goodDir, "app", "page.tsx"), "v9");
    const { execFile: ex } = await import("node:child_process");
    const { promisify: pr } = await import("node:util");
    const runLocal = pr(ex);
    await runLocal("tar", ["-czf", path.join(tmp, "good.tar.gz"), "-C", tmp, "rel-v9"]);
    // Evil twin: absolute path + .. entries.
    // Evil twin with a .. entry. Crafted with python tarfile (stdlib) because
    // BSD tar cannot append-transform one into existence.
    await runLocal("python3", ["-c", [
      "import tarfile, io",
      `t = tarfile.open(${JSON.stringify(path.join(tmp, "evil.tar.gz"))}, "w:gz")`,
      `b = b"x"`,
      `i = tarfile.TarInfo("../evil.txt"); i.size = len(b)`,
      "t.addfile(i, io.BytesIO(b))",
      "t.close()",
    ].join("; ")]);
    const server = createServer((req, res) => {
      if (req.url === "/good.tar.gz") {
        res.writeHead(200, { "Content-Type": "application/gzip" });
        createReadStream(path.join(tmp, "good.tar.gz")).pipe(res);
      } else if (req.url === "/evil.tar.gz") {
        res.writeHead(200, { "Content-Type": "application/gzip" });
        createReadStream(path.join(tmp, "evil.tar.gz")).pipe(res);
      } else if (req.url === "/big.tar.gz") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end("x".repeat(1024));
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const dest = path.join(tmp, "dl.tar.gz");
    const n = await runLib.downloadTarball(`http://127.0.0.1:${port}/good.tar.gz`, dest);
    ok(n > 0, "tarball downloads", `${n} bytes`);
    ok((await fs.stat(dest)).size === n, "downloaded size matches");
    const top = await runLib.validateTarball(dest);
    ok(top === "rel-v9", "single top-level dir accepted", top);
    let evilRefused = false;
    try {
      const evilDest = path.join(tmp, "evil.tar.gz");
      await runLib.downloadTarball(`http://127.0.0.1:${port}/evil.tar.gz`, evilDest);
      await runLib.validateTarball(evilDest);
    } catch {
      evilRefused = true;
    }
    ok(evilRefused, ".. entries refused");
    let missingRefused = false;
    try {
      await runLib.downloadTarball(`http://127.0.0.1:${port}/nope.tar.gz`, path.join(tmp, "nope.tar.gz"));
    } catch {
      missingRefused = true;
    }
    ok(missingRefused, "404 download throws");
    await new Promise<void>((r) => server.close(() => r()));
  }

  // ---- step runner ----
  const out = await update.runStep(process.execPath, ["-e", "console.log('hi')"], tmp, 30000);
  ok(out.trim() === "hi", "runStep captures output");
  let threw = false;
  try {
    await update.runStep(process.execPath, ["-e", "console.error('boom');process.exit(3)"], tmp, 30000);
  } catch (e) {
    threw = /boom/.test((e as Error).message);
  }
  ok(threw, "runStep throws with the tail on failure");

  // ---- environment probes ----
  const npm = await update.findNpm();
  ok(npm.endsWith("npm"), "findNpm resolves", npm);
  const free = await update.freeDiskBytes(tmp);
  ok(typeof free === "number" && (free as number) > 0, "free disk reads positive");
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`  ${passed}/${passed + failed} update assertions passed`);
if (failed) process.exitCode = 1;
