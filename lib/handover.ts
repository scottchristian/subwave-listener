// Handing the application over from root to an unprivileged account.
//
// WHY THIS IS ITS OWN MODULE. It shells out to root-level commands from a web
// request, and every step has a way to go wrong. The decision logic is pure and
// tested (handoverPlan); this file does the doing.
//
// WHY IT IS OFFERED AT ALL. Running as root is the single largest thing wrong
// with a default deployment, and the reason is specific rather than abstract: the
// setup wizard is an UNAUTHENTICATED web page until setup finishes. On a root
// install, anything that page can be talked into is done with root. Closing that
// window is worth an explicit, in-product offer.
//
// The ordering is deliberate and load-bearing. Everything that can fail is done
// BEFORE the irreversible part, and each of those steps is undone on failure:
//
//   1. create the account          — reversible (userdel)
//   2. grant the icecast group    — reversible (gpasswd -d)
//   3. widen the relay config      — reversible (chmod back)
//   4. write the sudo rule         — reversible (rm), and VALIDATED before use
//   5. hand over the directory     — reversible (chown back)
//
// Only step 6, swapping the running process, cannot be undone from here. It is
// last, it is announced before it happens, and the exact reversal is returned
// with the result so nobody is left guessing.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PM2_APP, PM2_BIN, pm2AppConfigured, cancelScheduledBounce } from "./pm2app";

const run = promisify(execFile);

/**
 * The account the application runs as.
 *
 * Fixed, and deliberately NOT derived from the package name. An earlier version
 * read `package.json` and used that, on the reasonable-sounding grounds that the
 * account should be named after the software rather than after a station. In
 * practice it meant the wizard created `subwave-web-player` while every document,
 * every example command and the existing station all said `subwave-listener` —
 * so an operator following the guide by hand and an operator using the wizard
 * ended up with two differently named accounts, and the handover could not
 * recognise the one it was supposed to be reusing.
 *
 * A name in package.json is a packaging decision that changes without anyone
 * intending to change a system account. This one changes on purpose.
 */
export const SERVICE_USER = "subwave-listener";
export const SERVICE_HOME = `/var/lib/${SERVICE_USER}`;
export const ICECAST_CONFIG = "/etc/icecast2/icecast.xml";
export const SUDOERS_FILE = `/etc/sudoers.d/${SERVICE_USER}`;

export type HandoverInput = {
  runningAsRoot: boolean;
  /** Is there a pm2 process name to restart? Without one there is no process to hand over. */
  pm2Configured: boolean;
  userExists: boolean;
  /** Does the relay config exist? Absence means no relay on this box. */
  icecastConfigExists: boolean;
};

export type HandoverPlan = {
  /** Can the wizard swap the running process, or only prepare and hand over by hand? */
  canAutomate: boolean;
  /** Why not, when it cannot. Shown to the operator verbatim. */
  reason?: string;
  /** Everything that will be done, so it can be shown before it is done. */
  steps: string[];
  /** Copy-pasteable commands for doing it without the wizard. */
  manual: string[];
  /** How to undo all of it. */
  revert: string[];
};

export function handoverPlan(input: HandoverInput, pm2AppName = ""): HandoverPlan {
  const user = SERVICE_USER;
  const appDir = process.cwd();

  const steps: string[] = [];
  const manual: string[] = [];
  const revert: string[] = [];

  if (input.userExists) steps.push(`Reuse the existing ${user} account.`);
  else {
    steps.push(`Create a system account: ${user}. No password, no login shell.`);
    manual.push(
      `useradd --system --create-home --home-dir ${SERVICE_HOME} --shell /usr/sbin/nologin --comment "Subwave Listener web player" ${user}`
    );
  }

  if (input.icecastConfigExists) {
    steps.push(`Let ${user} rewrite the relay config, so it can change the station password.`);
    manual.push(`usermod -aG icecast ${user}`);
    manual.push(`chmod 660 ${ICECAST_CONFIG}   # it is group-read only by default`);
  }

  steps.push(`Let ${user} reload the relay — one command, nothing else.`);
  manual.push(
    `printf '%s\\n' '${user} ALL=(root) NOPASSWD: /usr/bin/systemctl reload icecast2' > ${SUDOERS_FILE}`
  );
  manual.push(`chmod 440 ${SUDOERS_FILE}`);
  manual.push(`visudo -cf ${SUDOERS_FILE}   # must say "parsed OK"`);

  steps.push(`Hand the application directory to ${user}.`);
  manual.push(`chown -R ${user}:${user} "${appDir}"`);
  manual.push(`chmod 600 "${appDir}/.env.local"`);

  const canAutomate = input.runningAsRoot && input.pm2Configured;
  if (canAutomate) {
    steps.push(`Restart the application as ${user}. You will lose this page for a few seconds.`);
    manual.push(
      `pm2 delete all`,
      `su -s /bin/bash ${user} -c 'export HOME=${SERVICE_HOME} PM2_HOME=${SERVICE_HOME}/.pm2; cd "${appDir}" && pm2 start npm --name ${pm2AppName || user} --time -- start && pm2 save'`
    );
  } else if (input.runningAsRoot) {
    steps.push("Restart it yourself as that user — see the commands below.");
  }

  manual.push(`env PATH="$PATH:/usr/bin" pm2 startup systemd -u ${user} --hp ${SERVICE_HOME}`);
  manual.push(`systemctl disable pm2-root.service   # or two copies fight over the port`);

  revert.push(`rm -f ${SUDOERS_FILE}`);
  if (input.icecastConfigExists) revert.push(`chmod 640 ${ICECAST_CONFIG}`);
  revert.push(`chown -R root:root "${appDir}"`);
  revert.push(`userdel ${user}   # only if you created it just now`);

  return {
    canAutomate,
    reason: canAutomate
      ? undefined
      : input.runningAsRoot
        ? "This application was not started by pm2, so there is no process for this page to hand over. Run the commands below yourself, then restart setup."
        : "Already running as an unprivileged account.",
    steps,
    manual,
    revert,
  };
}

export type HandoverResult =
  | {
      ok: true;
      handoverStarted: boolean;
      /** Where the detached swap is writing, if one was started. */
      logPath?: string;
      output: string[];
      revert: string[];
      notes: string[];
    }
  | { ok: false; error: string; rolledBack: string[]; done: string[] };

/**
 * Perform the handover. Every step before the process swap is undone on failure.
 */
export async function performHandover(pm2AppName: string): Promise<HandoverResult> {
  const user = SERVICE_USER;
  const appDir = process.cwd();
  const output: string[] = [];
  const notes: string[] = [];

  // Any restart already queued would land in the middle of the steps below and
  // kill whichever one was running. See cancelScheduledBounce for what that
  // looks like when it happens.
  if (cancelScheduledBounce()) {
    notes.push(
      "A restart was already scheduled and has been called off, so it cannot interrupt the handover partway through.",
    );
  }

  const step = async (label: string, cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) => {
    await run(cmd, args, { timeout: 120_000, ...opts });
    output.push(label);
  };

  const exists = (p: string) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  // ---- 1. the account ----------------------------------------------------
  let createdUser = false;
  try {
    await run("id", ["-u", user], { timeout: 15_000 });
    notes.push(`Reused the existing ${user} account.`);
  } catch {
    try {
      await step(
        `created the ${user} account`,
        "useradd",
        [
          "--system",
          "--create-home",
          "--home-dir",
          SERVICE_HOME,
          "--shell",
          "/usr/sbin/nologin",
          "--comment",
          "Subwave Listener web player",
          user,
        ]
      );
      createdUser = true;
    } catch (e: any) {
      return {
        ok: false,
        error: `Could not create the ${user} account: ${failureReason(e)}`,
        rolledBack: [],
        done: [],
      };
    }
  }

  const rollback = async (done: string[]) => {
    const undone: string[] = [];
    const undo = async (label: string, cmd: string, args: string[]) => {
      try {
        await run(cmd, args, { timeout: 30_000 });
        undone.push(label);
      } catch {
        /* best effort — report what did not come back */
      }
    };
    if (done.includes("sudo rule")) await undo("removed the sudo rule", "rm", ["-f", SUDOERS_FILE]);
    if (done.includes("relay config writable")) {
      await undo("restored relay config permissions", "chmod", ["640", ICECAST_CONFIG]);
    }
    if (done.includes(`added ${user} to the icecast group`)) {
      await undo("removed the group grant", "gpasswd", ["-d", user, "icecast"]);
    }
    if (createdUser && done.includes(`created the ${user} account`)) {
      await undo("removed the account", "userdel", [user]);
    }
    return undone;
  };

  const done: string[] = [];

  // ---- 2. the group ------------------------------------------------------
  if (exists(ICECAST_CONFIG)) {
    try {
      await step(`added ${user} to the icecast group`, "usermod", ["-aG", "icecast", user]);
      done.push(`added ${user} to the icecast group`);
    } catch (e: any) {
      return {
        ok: false,
        error: `Could not grant the icecast group: ${failureReason(e)}. This box may have no group by that name.`,
        rolledBack: await rollback(done),
        done,
      };
    }
    try {
      // 640 is group-READ. The app has to be able to write it, and that is the
      // only capability this group membership actually grants.
      await step("made the relay config writable", "chmod", ["660", ICECAST_CONFIG]);
      done.push("relay config writable");
    } catch (e: any) {
      return {
        ok: false,
        error: `Could not make ${ICECAST_CONFIG} writable by its group: ${failureReason(e)}`,
        rolledBack: await rollback(done),
        done,
      };
    }
  } else {
    notes.push(`No relay config at ${ICECAST_CONFIG}, so no group grant was needed.`);
  }

  // ---- 3. the sudo rule, validated before it is trusted ------------------
  const rule = `# The web player rewrites the Icecast relay password when an operator changes\n` +
    `# the station password, and asks Icecast to reload.\n` +
    `#\n` +
    `# Scoped to this ONE command. Do not widen it to "systemctl *" or NOPASSWD:\n` +
    `# that hands the web process root back through the front door.\n` +
    `${user} ALL=(root) NOPASSWD: /usr/bin/systemctl reload icecast2\n`;
  try {
    fs.writeFileSync(SUDOERS_FILE, rule, { mode: 0o440 });
    fs.chmodSync(SUDOERS_FILE, 0o440);
    // A syntax error in sudoers can lock sudo out entirely, so never trust this
    // file until visudo has read it back.
    await step("validated the sudo rule", "visudo", ["-cf", SUDOERS_FILE]);
    done.push("sudo rule");
  } catch (e: any) {
    try {
      fs.rmSync(SUDOERS_FILE, { force: true });
    } catch {}
    return {
      ok: false,
      error: `The sudo rule did not validate, so it was removed and nothing else was touched: ${failureReason(e)}`,
      rolledBack: [],
      done,
    };
  }

  // ---- 4. the directory --------------------------------------------------
  try {
    await step(`gave ${appDir} to ${user}`, "chown", ["-R", `${user}:${user}`, appDir]);
    done.push("directory ownership");
    await step("protected the secrets file", "chmod", ["600", path.join(appDir, ".env.local")]);
    done.push("env file mode");
  } catch (e: any) {
    return {
      ok: false,
      error: `Could not hand over the application directory: ${failureReason(e)}`,
      rolledBack: await rollback(done),
      done,
    };
  }

  // ---- 5. the process swap — the irreversible one -------------------------
  //
  // It cannot be done here. `pm2 delete all` kills the process making this
  // request, so anything this function did afterwards would never run: the
  // response would not be written, and the application would never come back.
  // That was not a theoretical concern — running the handover for real against
  // a container left the station down and the operator staring at a dead
  // browser tab, with the failure message confidently claiming the old process
  // was "still running as root and still serving". It was not.
  //
  // So the swap is handed to a detached process. `detached` puts it in its own
  // process group, so the kill does not reach it; `unref` stops this process
  // waiting on it. The sleep is there so the HTTP response is flushed and
  // reaches the browser BEFORE the old process goes away, which is what makes
  // the page's "you will lose this page for a few seconds" true rather than
  // aspirational.
  let handoverStarted = false;
  if (!pm2AppName) {
    notes.push(
      "There was no pm2 process name to restart, so the application is still running as root. Restart it as the new account using the commands above.",
    );
    return { ok: true, handoverStarted, output, revert: ["rm -f " + SUDOERS_FILE], notes };
  }

  const swap = scheduleSwap({ user, appDir, pm2AppName });
  if (!swap.started) {
    // The account, groups, permissions and sudo rule are all in place. Only the
    // swap did not start, and it is the one step that cannot be rolled back
    // because the process it would have replaced is the one running this code.
    // The old process is genuinely still serving, so this is recoverable by hand.
    return {
      ok: false,
      error:
        `Everything is set up for ${user}, but the restart could not be scheduled: ${failureReason(swap.error)}\n\n` +
        `The application is still running as root and still serving. To finish by hand:\n` +
        manualSwap(user, appDir, pm2AppName) +
        `Nothing has been lost, and you can also undo all of it:\n  ${["rm -f " + SUDOERS_FILE, `chown -R root:root "${appDir}"`].join("\n  ")}`,
      rolledBack: [],
      done,
    };
  }

  handoverStarted = true;
  done.push("process handover");
  output.push(`restarting the application as ${user}`);
  notes.push(
    `This page will go away for a few seconds while the application restarts as ${user}. ` +
      `That is expected. If it does not come back, the commands are printed below, and the ` +
      `log is at ${swap.logPath}.`,
  );

  return { ok: true, handoverStarted, logPath: swap.logPath, output, revert: [], notes };
}

/** The commands that perform the swap, for a human to run or to read. */
function manualSwap(user: string, appDir: string, pm2AppName: string): string {
  return (
    `  pm2 delete all\n` +
    `  su -s /bin/bash ${user} -c 'export HOME=/var/lib/${user} PM2_HOME=/var/lib/${user}/.pm2; cd "${appDir}" && pm2 start npm --name ${pm2AppName} --time -- start && pm2 save'\n`
  );
}

/**
 * Start the swap in a process that outlives this one.
 *
 * The script is written to a file rather than passed as a shell string, because
 * the app directory and the pm2 process name are both operator-supplied and
 * neither is safe to interpolate into a command line.
 */
function scheduleSwap(args: {
  user: string;
  appDir: string;
  pm2AppName: string;
}): { started: boolean; logPath?: string; error?: unknown } {
  const { user, appDir, pm2AppName } = args;
  const logPath = path.join(os.tmpdir(), "subwave-listener-handover.log");
  const scriptPath = path.join(os.tmpdir(), "subwave-listener-handover.sh");

  const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

  // HOME, explicitly, for the whole script — and the reason is worth stating
  // because it looks redundant. `su user -c` sets HOME correctly when a person
  // runs it from a login shell, and it did here too, so this looked unnecessary.
  // It is necessary because this script is not started from a login shell: it
  // inherits root's environment, and pm2 puts its daemon socket, its logs and
  // its dump in $HOME/.pm2. With HOME still /root, the new account's pm2 tried to
  // create /root/.pm2, was refused, and the application never started. The
  // handover had already reported success by then, and the station was down.
  const userHome = `/var/lib/${user}`;

  // PM2_HOME, not just HOME. pm2 sets PM2_HOME=/root/.pm2 in the environment of
  // every process it starts, so the app process has it, so the swap script
  // inherits it, and it takes precedence over HOME inside pm2. Exporting HOME —
  // which is the obvious thing to do, and which works when a person runs the
  // command by hand — changed nothing at all here: pm2 went on using
  // /root/.pm2, was refused permission to create it as the unprivileged
  // account, and the application never started. The handover had already
  // reported success, so the station was left down with a log full of EACCES.
  //
  // Also clearing the npm_* variables the app was started with, for the same
  // reason: they point at root's home and would otherwise follow the new
  // account's pm2 into npm's cache and config.
  const cleanEnv =
    `unset PM2_HOME PM2_USAGE PM2_INTERACTOR_PROCESSING; ` +
    `export HOME=${q(userHome)} PM2_HOME=${q(userHome + "/.pm2")} PM2_BIN=${q(PM2_BIN)}; ` +
    `for v in $(env | sed -n 's/^\\(npm_[A-Za-z_]*\\)=.*/\\1/p'); do unset "$v"; done; `;

  const script = [
    "#!/bin/sh",
    "# Written by the setup wizard. Restarts the application as the unprivileged",
    "# account. Runs detached because the process it replaces is the one asking.",
    `LOG=${q(logPath)}`,
    `say() { printf '%s %s\\n' "$(date -u +%H:%M:%S)" "$*" >> "$LOG"; }`,
    `: > "$LOG"`,
    `say "handing over to ${user}, log follows"`,
    // Let the HTTP response reach the browser before this process disappears.
    "sleep 2",
    `say "stopping the root process"`,
    `if pm2 delete all >>"$LOG" 2>&1; then say "stopped"; else say "pm2 delete failed"; fi`,
    `say "starting as ${user}"`,
    `if su -s /bin/bash ${q(user)} -c ${q(`${cleanEnv}cd ${q(appDir)} && pm2 start npm --name ${q(pm2AppName)} --time -- start && pm2 save`)} >>"$LOG" 2>&1; then`,
    `  say "started as ${user}"`,
    `else`,
    `  say "FAILED to start as ${user} — run the commands printed in the wizard by hand"`,
    `  exit 1`,
    `fi`,
    // Best effort: two enabled pm2 services would fight over the port on reboot.
    `if systemctl disable pm2-root.service >>"$LOG" 2>&1; then`,
    `  say "disabled the old root pm2 boot service"`,
    `else`,
    `  say "note: could not disable pm2-root.service — check only one pm2 service is enabled"`,
    `fi`,
    `say "done"`,
  ].join("\n");

  try {
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    // `detached` alone is NOT enough, and that cost an afternoon to find out.
    // It calls setsid, which gives the child its own session and process group,
    // but the child is still this process's child, and pm2 kills by walking the
    // parent-child chain rather than by signalling a group. So `pm2 delete all`
    // found the swap script, killed it, and the application never came back —
    // the handover reported success and left the station down.
    //
    // The extra shell here backgrounds the script and exits immediately, so the
    // script is re-parented to init before the delete runs two seconds later. By
    // then it is not in this process's tree at all, and nothing that kills this
    // process can reach it.
    spawn("/bin/sh", ["-c", `setsid /bin/sh ${q(scriptPath)} >/dev/null 2>&1 &`], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return { started: true, logPath };
  } catch (e) {
    return { started: false, error: e };
  }
}

/**
 * The reason a command failed, in a form worth putting in front of an operator.
 *
 * The first attempt at this took the first line of the error, which for a failed
 * execFile is always "Command failed: chown -R …" — the command, not the reason.
 * The stderr carrying the actual complaint is on the second line, so it was being
 * thrown away, and a real failure was reported to the operator as a restatement
 * of the command they had just watched run. stderr first, then the message, and
 * a few lines rather than one: this string is the only evidence available when
 * something fails on a machine nobody is sitting at.
 */
const failureReason = (e: any): string => {
  const stderr = String(e?.stderr || "").trim();
  if (stderr) {
    return stderr
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join("; ")
      .slice(0, 400);
  }
  // No stderr: the process was signalled or timed out rather than exiting with a
  // complaint, and that distinction is the whole diagnosis.
  if (e?.killed || e?.signal) {
    return `the command was killed (${e.signal || "timeout"}) before it finished`;
  }
  if (e?.code === "ENOENT") {
    return `the command is not installed on this machine (${e.path || "unknown"})`;
  }
  return String(e?.message || e).split("\n")[0].trim().slice(0, 300);
};
