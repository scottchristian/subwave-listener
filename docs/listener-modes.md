# Listener counting & real IPs: diagnosis and plan

Branch: `listener-count`. **IMPLEMENTED** — relay default, direct opt-in via
Admin → Stream Mode card. Notes below remain the design record.

## 1. Measured facts (all verified live, Sep 2026)

| # | Fact | How verified |
|---|------|--------------|
| 1 | VPS relay is **stock Icecast 2.4.4** (`icecast2 -v`), bound to `127.0.0.1:8000` | `ps` + `ss` on VPS |
| 2 | Stock 2.4.4 **ignores `X-Forwarded-For`** for listener IPs | Sent `X-Forwarded-For: 9.9.9.9` direct to relay; `listclients` still showed `127.0.0.1`. Xiph wiki confirms: stock always shows the proxy peer. The `<x-forwarded-for>127.0.0.1</x-forwarded-for>` line in our `icecast.xml` is inert here |
| 3 | Proxmox **master is Icecast-KH22** | `www-authenticate: Basic realm="Icecast 2.4.0-kh22"` on the public `/stream.mp3` 401 |
| 4 | Full public chain works with **query auth**: `…/stream.mp3?auth=PASS` → **206 + bytes**, including `Range: 0-2000` partial | Live curl with the real station password |
| 5 | `listener:PASS` Basic also → **206**. Port `:8000` is closed externally; only `127.0.0.1`-bound | Live curl |
| 6 | NGINX (both hosts) forwards `X-Real-IP` + `X-Forwarded-For`; our Next proxy forwards them to the relay | Config files + `app/api/stream/route.ts` |
| 7 | Controller has **no live-presence channel**: `/beacon` is marketing analytics (referrers/countries, hashed IPs, daily buckets), not a listener feed | `controller/src/broadcast/audience.ts` |
| 8 | Idle monitor + `pauseWhenEmpty` work; `streamIdle: True` observed live | `/api/state` |
| 9 | Backend count reads **0 while a phone plays** (screenshot) | Operator report + `/api/now-playing` |
| 10 | Subwave upstream already renders **trusted-proxy `<x-forwarded-for>`** entries from `ICECAST_TRUSTED_PROXY_IPS` (exact-IP match, entrypoint + `docs/reverse-proxy.md`) | `docker/broadcast-entrypoint.sh`, `docs/reverse-proxy.md` |

## 2. How the chain actually works

```
listener browser
  → causewayfm.com:443 (VPS NGINX, adds X-Real-IP/XFF)
  → 127.0.0.1:3000 (Next /api/stream proxy, forwards XFF, ?auth=PASS to relay)
  → 127.0.0.1:8000 (VPS stock relay, on-demand, 1 upstream socket)
  → [ipv6]:7700 (Proxmox Caddy edge)
  → broadcast Icecast-KH22 (sees ONE connection: the relay, peer = Caddy container IP, e.g. 172.16.0.1)
```

Public direct path (already live, unused by us):
`radio.ghostmaster.online/stream.mp3` → NGINX → Proxmox Caddy → KH22 master (listener-auth enforced, 401 without creds).

Consequences:
- The master can **never** see per-listener IPs behind the relay (one socket). Relay-mode truth lives **only** at the VPS relay — which, being stock, can only ever report `127.0.0.1` per socket.
- The `172.16.0.1` on the DJ dashboard is Caddy's container address as seen by broadcast Icecast — i.e. the controller is currently polling the **local** master (or nothing resolving), not the VPS relay.
- "Worked in the past" = `ICECAST_ADMIN_URL` (+ password) pointed at the VPS relay. It regresses silently whenever rebuilt without those vars, or when the VPS relay admin password rotates (auto-generated hex).

## 3. Target states

**Relay mode (default):** backend reports the TRUE COUNT (N relay sockets) via VPS-relay admin polling. Per-row IPs stay `127.0.0.1` — a stock-Icecast law, not a bug. Real per-listener identity lives in OUR admin (presence heartbeats + stream sessions, both carry true IPs).

**Direct (1:1) mode (opt-in):** player connects straight to the public master URL with `?auth=`. Backend sees N native listeners with real IPs (KH + trusted Caddy peer), zero code changes on the host. Costs: backend upload scales per listener; station password becomes view-source-visible to approved listeners (they're approved — treat as shareable, rotate if leaked); relay idles as fallback.

## 4. Changes required

### Host (Proxmox `.env`, operator applies — no code patches)

```bash
# Count the relay instead of the empty local master:
ICECAST_ADMIN_URL=http://100.109.147.71:8000/admin/listclients
ICECAST_STATUS_URL=http://100.109.147.71:8000/status-json.xsl
# Relay's admin password (VPS /etc/icecast2/icecast.xml <admin-password>).
# Static by operator choice — auto-rotation silently breaks counting.
ICECAST_ADMIN_PASSWORD=<vps-relay-admin-password>
# Caddy's container address as broadcast Icecast sees it (read it off the
# current wrong row in Admin → Listeners, e.g. 172.16.0.1). Exact IP only.
ICECAST_TRUSTED_PROXY_IPS=<caddy-container-ip>
# PINNED — every broadcast recreate without this rotates the relay password
# and strands the VPS relay (mount 404s until re-pinned). This exact failure
# happened live during this work and is the likely "worked in the past"
# regression shape.
ICECAST_RELAY_PASSWORD=<must-match the password in VPS relay <password>>
```

Then `docker compose up -d broadcast controller` (**`up`, not `restart` —
`restart` reuses containers and never re-reads `.env`**). Verify in
Admin → Listeners: N rows (all `127.0.0.1` in relay mode — expected), count
matches phones playing.

**APPLIED Sep 2026** (via jump host, `up -d` both services): admin/status
URLs → tailnet relay, admin password set, relay password pinned to the VPS
value, relay verified 200 on both sockets, backend connections endpoint live.
Pending live proof: 2 devices playing → backend count 2.

**How the controller reaches the relay: Tailscale (or similar).** The relay
binds `127.0.0.1:8000` (this machine's proxy) **and** the VPS Tailscale address
(`100.109.147.71:8000`, tailnet-private) — no public exposure. So the
controller side needs a tailnet route to the VPS:

- Recommended: `tailscale up` on the Proxmox host (or container host). Then the
  `http://100.109.147.71:8000/…` URLs above work as written.
- Alternative without Tailscale: bind the relay publicly and scope the
  firewall to the Proxmox source IP only
  (`iptables -A INPUT -p tcp --dport 8000 -s <proxmox-ip> -j ACCEPT` +
  drop the rest, persisted). This works but puts the admin surface (password
  gated) and the public `status-json` on the open internet — do Tailscale
  instead unless it is unavailable.
- Either way the relay's `<admin-password>` must be copied into Proxmox
  `ICECAST_ADMIN_PASSWORD` verbatim; a rotated/typo'd password fails the same
  silent way (controller falls back, counts go wrong, nothing logs loudly —
  check Admin → Listeners first whenever counts look off).

### VPS NGINX hardening (same deploy)

`$proxy_add_x_forwarded_for` appends (client-seedable). Upstream recipe overwrites:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

in both `causewayfm` and `radio.ghostmaster.online` blocks. Counts sockets so spoofing can't inflate them, but our forwarded identity should still be clean.

### Our repo (this branch)

1. `streamMode` setting (`relay` default): dedicated **Stream Mode card** in Admin — mode toggle with the upload-cost + password-visibility warnings inline, plus current mode and a live per-path breakdown (relay sockets vs direct listeners).
2. Player: `audio.src = direct ? ${publicMaster}/stream.mp3?auth=${stationPassword-from-settings-endpoint} : /api/stream?…`. Station password needs a client-readable endpoint — extend `/api/settings` (approved-only; direct mode inherently discloses it to approved listeners: stated on the card).
3. Switching modes mid-listen: stop + replay (same as Stop/Play).
4. Keep relay warm: on-demand relay stays configured; direct listeners bypass it.
5. Docs (part of the definition of done, not an afterthought):
   - `docs/listener-modes.md` (this file): architecture, trade-offs, verification.
   - `docs/settings.md`: per-field explanation of the Stream Mode card.
   - README architecture paragraph: one-relay-fans-out vs direct lines.
   - Admin UI carries the warnings inline (upload cost, password visibility),
     so the docs are backup, not the only copy.

### Explicitly NOT doing

- Swapping the VPS relay to Icecast-KH (custom build, ops burden) — stock + controller polling + direct-mode option covers every stated need.
- Out-of-band presence reporting (Next → controller endpoint): real value, but a controller hot-patch on Proxmox with merge debt on every upstream pull. Revisit only if per-listener backend identity behind the relay becomes a hard requirement (our admin already has it).
- Per-user mode choice: global operator setting. Per-user splits the audience across two audio paths and doubles every future playback bug.

## 5. Verification matrix (run before merging)

| Test | Relay mode expect | Direct mode expect |
|------|-------------------|--------------------|
| 1 phone plays | backend count 1 | backend count 1, real IP row |
| 2nd phone joins | count 2, both `127.0.0.1` | count 2, two real IPs |
| All stop 3+ min | `streamIdle: True`, mounts silent | same |
| Wrong password in direct URL | n/a | 401, player shows reconnect treatment |
| `?auth=` + Safari Range probes | n/a (proxy path) | 206 partials, single counted listener (UA dedupe) |

## 6. Rollout / rollback

1. Host `.env` edits → recreate broadcast+controller → verify Listeners table.
2. Merge this branch → normal listener-guard deploy (`--force` only if room occupied).
3. Flip direct mode on a quiet hour; watch upload on Proxmox + Safari behavior.
4. Rollback: toggle back to relay (instant, no deploy); host `.env` revert + recreate if needed.

## 7. Open questions for the operator — ANSWERED by direct login (Sep 2026)

- ~~Confirm current Proxmox `ICECAST_ADMIN_URL` value~~ — not directly readable
  over HTTP, but behavior says it all: backend reads **0 while a phone plays**,
  and the connections endpoint works (200, reachable Icecast). The operator
  checklist below still confirms which Icecast on their side.
- ~~Confirm the wrong IP currently on Admin → Listeners~~ — answered
  structurally instead: `GET /api/listeners/connections` (admin creds) returns
  `trustedProxies: {known:false, count:0}` — **nothing is trusted** on the
  broadcast Icecast today. So even direct-mode listeners would currently show
  the Caddy peer address, and `ICECAST_TRUSTED_PROXY_IPS` is confirmed
  unset/empty. Setting it is required, not optional.
- Bonus finding: `DATABASE_URL` must be exported for ANY local Prisma CLI run
  (`export $(grep ^DATABASE_URL .env.local | xargs)`) — the CLI reads `.env`,
  never `.env.local`. The deploy script already does this; ad-hoc commands
  kept tripping on it during this investigation.
