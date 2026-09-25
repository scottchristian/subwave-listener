# Settings & Credentials Guide

Every value the player needs, where to get it, and where it lives. Most live
in **Admin → cards** (applied live or with an automatic rebuild); only three
are server-env-only.

## Google Sign-In (Admin → Google Sign-In)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → new project (any name).
2. **APIs & Services → OAuth consent screen** → User type **External** → fill app name + support email → Save. Add yourself under **Test users** while developing (or Publish the app for open sign-ups).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → type **Web application**.
4. Under **Authorized redirect URIs** add exactly:
   `https://YOUR-HOST/api/auth/callback/google`
   (http + localhost works for local dev: `http://localhost:3000/api/auth/callback/google`).
5. Copy the **Client ID** and **Client secret** into the Admin card and Save.
   The station restarts (~2s) to pick them up.
6. Set **Admin Email** to your address — matching sign-ins auto-approve as admin.

If logins fail after a change, the redirect URI almost never matches the app URL
character-for-character (scheme, host, trailing slash). That mismatch is the
cause ~every time.

## Spotify track links (Admin → Music Links)

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → Create app (any name/description).
2. Copy **Client ID** and **Client Secret** into the card and Save. Applies on
   the next lookup — no restart.
3. No redirect URI needed (server-to-server token flow). Apple Music links need
   no keys at all (unauthenticated iTunes lookup).

## Push keys (Admin → Push Notifications)

1. Run `npx web-push generate-vapid-keys` anywhere.
2. Paste the pair (+ a `mailto:` contact) and Save. Applies immediately.
3. Rotating keys orphans existing devices — they re-subscribe on next admin
   visit, dead endpoints self-prune on 410/404.

## Donations (Admin → Support Button)

- Button URL/text are cosmetic. The **webhook secret** must match the secret in
  your Buy Me A Coffee dashboard (Settings → Webhook) — it HMAC-verifies
  incoming donation events. Applies immediately.

## Sub/Wave backend (Admin → Sub/Wave Server)

- **API base URL**: the controller's public address (browser-called, so never a
  LAN IP). `/api` appended if missing.
- **Relay stream URL**: the local Icecast relay listeners actually play
  (`http://127.0.0.1:8000/stream.mp3`). Never point this at the backend — one
  upstream connection per listener would replace the 1-to-many relay.
- **Username/password**: the backend `ADMIN_USER`/`ADMIN_PASS` — powers skip
  and never-play forwarding.
- **Station password**: listener auth. Saving repoints the relay master
  password too (verified live, or the stream dies).

## Station Identity (Admin → Station Identity)

Name, tagline, description, about, logo path, public URLs. Baked at build
time: Save rebuilds (~1min) and restarts only on a fresh `BUILD_ID` — a failed
build keeps the old version running.

## Stream Mode (Admin → Stream Mode)

- **1-to-many relay** (default): one upstream connection feeds every listener.
  Backend counts relay sockets; per-listener identity lives in Signed In.
- **1-to-1 direct**: each player connects straight to the master with
  `?auth=`. The backend sees true counts and real IPs natively — at the cost
  of backend upload per listener, and the station password shipping in page JS
  (approved eyes only; rotate if shared). Applies on next Play.

## Env-only (never in UI, by design)

- `NEXTAUTH_SECRET` — signs session JWTs. Rotating logs everyone out; no UI
  recovery path, so it stays in `.env.local`. Generate:
  `openssl rand -base64 32`.
- `DATABASE_URL` — moving the SQLite file is a migration, not a setting.
- `PM2_APP_NAME` — restart mechanics, read before the app boots.
