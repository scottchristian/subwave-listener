import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export const ICECAST_XML = "/etc/icecast2/icecast.xml";
// The mount the 1-to-many relay republishes locally. The master mount stays
// fixed — only server/port/password follow the admin's Sub/Wave Server card.
const MASTER_MOUNT = "/stream.mp3";

const escXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// apiUrl is the controller API base (…:7700/api). The relay needs the bare
// host + port of that same backend.
export function backendFromApiUrl(apiUrl: string): { server: string; port: number } {
  const u = new URL(apiUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Server address must be an http(s) URL");
  }
  let server = u.hostname;
  // u.hostname is the BARE address (no brackets) — exactly what Icecast's
  // <server> wants. It brackets IPv6 itself when connecting; handing it
  // "[...]" makes the relay fail with "Failed to connect". Strip defensively
  // too, so a bracketed paste can never poison icecast.xml.
  if (server.startsWith("[") && server.endsWith("]")) server = server.slice(1, -1);
  const port = u.port ? parseInt(u.port, 10) : 7700;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error("Server address has an invalid port");
  }
  return { server, port };
}

function setRelayTag(xml: string, tag: "server" | "port" | "password", value: string): string {
  const re = new RegExp(`(<relay>[\\s\\S]*?<${tag}>)([^<]*)(</${tag}>)`);
  if (!re.test(xml)) throw new Error(`icecast.xml has no <relay><${tag}> to update`);
  return xml.replace(re, `$1${value}$3`);
}

/**
 * Repoint the local 1-to-many Icecast relay at the admin-configured backend
 * and rotate its master password, then reload Icecast and prove the local
 * mount answers. Throws with a human-readable message on any failure.
 */
export async function syncRelay(opts: {
  apiUrl: string;
  stationPassword: string;
}): Promise<{ server: string; port: number; changed: boolean; streamOk: boolean }> {
  if (!opts.stationPassword) throw new Error("Station password is empty — not syncing the relay");
  const { server, port } = backendFromApiUrl(opts.apiUrl);

  const before = await fs.readFile(ICECAST_XML, "utf8");
  let after = setRelayTag(before, "server", server);
  after = setRelayTag(after, "port", String(port));
  after = setRelayTag(after, "password", escXml(opts.stationPassword));
  const changed = after !== before;

  if (changed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.copyFile(ICECAST_XML, `${ICECAST_XML}.bak-${stamp}`);
    await fs.writeFile(ICECAST_XML, after, "utf8");
  }

  // SIGHUP re-reads the config including relay definitions.
  await run("systemctl", ["reload", "icecast2"]);

  // On-demand relay connects on request — a GET proves master + password.
  // Wait past the reload + connect window; an instant check 404s while the
  // relay is still dialling the master.
  await new Promise((r) => setTimeout(r, 5000));
  const res = await fetch("http://127.0.0.1:8000/stream.mp3", {
    signal: AbortSignal.timeout(15000),
  });
  await res.body?.cancel().catch(() => {});
  if (!res.ok) {
    throw new Error(
      `Relay reloaded but local ${MASTER_MOUNT} answers ${res.status} — check server address/password`
    );
  }
  return { server, port, changed, streamOk: res.ok };
}
