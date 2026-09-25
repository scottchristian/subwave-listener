# Subwave Web Player

Listener-facing web player for a [Subwave](https://github.com/) internet radio station: approvals-gated listening, live now-playing with delay-synced UI, song requests, likes with platform links, admin dashboard (users, stats, server, push), and PWA install support.

## Setup (new station)

1. `npm install`
2. `cp .env.example .env.local` and fill it in (station name, backend URL, Google OAuth, secrets).
3. Rebrand: replace `public/official_logo.png` (header/sign-in), `public/bg.jpg` (backdrop), then regenerate icons:
   `public/icons/*` + `app/favicon.ico` are built from the logo (any 1024×1024 source works).
4. `npx prisma migrate deploy` (SQLite at `DATABASE_URL`).
5. `npm run build && pm2 start npm --name "$PM2_APP_NAME" -- start` (or `npm run dev`).

Everything else configures itself at runtime:
- Support button, Subwave server address/creds, Google sign-in: Admin dashboard (no restarts except Google creds, which bounce the process by design).
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

## License

MIT — see [LICENSE](LICENSE).
