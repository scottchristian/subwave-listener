# Subwave Web Player

Listener-facing web player for a [Subwave](https://github.com/perminder-klair/subwave) internet radio station: approvals-gated listening, live now-playing with delay-synced UI, song requests, likes with platform links, admin dashboard (users, stats, server, push), and PWA install support.

## Why this exists

Subwave broadcasts **one** stream from wherever it runs (often a home server
with thin upload). This app runs on a cheap VPS next to your listeners and:

- **Multiplies that one stream.** A co-hosted Icecast relay holds a single
  connection back to Subwave and fans it out to unlimited listeners on the
  VPS's bandwidth — Subwave still only ever uploads once.
- **Gates who listens.** Google sign-in plus per-user approval: nobody hears a
  second of audio until an admin lets them in. Revoke or remove accounts any
  time.
- **Stays yours.** Station name, branding, backend address and every secret
  configure from env + the admin dashboard — fork it, rebrand it, run as many
  of them as you like.

## Setup (new station)

1. `npm install`
2. `cp .env.example .env.local` and fill it in (station name, backend URL, Google OAuth, secrets).
3. Rebrand: replace `public/official_logo.png` (header/sign-in), `public/bg.jpg` (backdrop), then regenerate icons:
   `public/icons/*` + `app/favicon.ico` are built from the logo (any 1024×1024 source works).
4. `npx prisma migrate deploy` (SQLite at `DATABASE_URL`).
5. `npm run build && pm2 start npm --name "$PM2_APP_NAME" -- start` (or `npm run dev`).

Everything else configures itself at runtime:
- Support button (+ BMAC secret), Sub/Wave server (API, relay stream, creds, station password), Google sign-in, VAPID push keys, Spotify creds, station identity: Admin dashboard (identity rebuilds+restarts; the rest apply live).
- Env-only by design: `NEXTAUTH_SECRET` (guards JWT), `DATABASE_URL` (moving the DB is a migration, not a setting), `PM2_APP_NAME` (restart mechanics).
- Per-user data (likes, requests, sessions) accrues in SQLite.

## Architecture

- `app/page.tsx` — the player (feed polling, audio, tour, overlays).
- `app/admin/` — approvals, users, stats, settings, push.
- `app/api/` — NextAuth, stream proxy (`/api/stream` pulls the local Icecast relay), request/skip/block/like proxies to the Subwave backend, link resolver, push.
- `lib/station.ts` — ALL station identity/branding (env-driven, neutral defaults). Rename here, nowhere else.
- `lib/subwave.ts` — backend connection (DB settings first, env fallback).
- `lib/relay.ts` — keeps a co-hosted Icecast relay pointed at the backend on Save.

## Rules for contributors

- Every interactive element gets an `id` (operators direct agents at them).
- Never commit `.env.local`, `data/`, or any `*.db` — see `.gitignore`.
- Settings/credentials how-to lives in [docs/settings.md](docs/settings.md).

## License

MIT — see [LICENSE](LICENSE).
