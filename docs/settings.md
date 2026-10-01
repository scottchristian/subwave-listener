# Settings and credentials

Every setting in the admin dashboard: what it does, whether you need it, and
whether it takes effect immediately or needs a restart.

- [Where a setting can live](#where-a-setting-can-live)
- [Station](#station)
- [People and permissions](#people-and-permissions)
- [Sub/Wave station](#subwave-station)
- [Support and donations](#support-and-donations)
- [Google sign-in](#google-sign-in)
- [Push notifications](#push-notifications)
- [Music links](#music-links)
- [Skills](#skills)
- [Settings that are not in the dashboard](#settings-that-are-not-in-the-dashboard)

---

## Where a setting can live

Almost every setting can be set in two places, and the dashboard wins:

1. **The admin dashboard.** Saved in the database and read on every request, so
   it takes effect immediately.
2. **The configuration file on your server** (`.env.local`). This is the
   fallback, and it is what a fresh install starts from. The dashboard also
   *writes to this file* for the handful of values that have to survive a
   rebuild — your branding and your Google credentials.

A few settings are **only** in the configuration file, by design. Those are at
the [end of this document](#settings-that-are-not-in-the-dashboard), and there
are only four.

**Station settings are the exception.** Anything named `NEXT_PUBLIC_` is
compiled into the code the browser downloads, at the moment you build. Saving
Station Identity therefore triggers a rebuild and a restart, which takes about a
minute and interrupts playback. Nothing else in the application does that.

---

## Station

### Station Identity — rebuilds and restarts

**What it does.** Sets your station's name, tagline, description, the longer text
on the sign-in screen, the logo, the public address of your station, and this
application's own address.

**Do you need it?** The name, description and logo, yes — otherwise the page
says "Community Radio" and shows a placeholder logo. The two addresses, yes,
though they are also in your configuration file and it is better to get them
right there once.

**When it applies.** Immediately, once the rebuild finishes.

**What happens when you save.** The values are written to your configuration
file, the application is rebuilt, and it restarts — but **only if the build
succeeded**. If the build fails, the old version keeps running and the page tells
you so. That is deliberate: a failed build should not take your station offline.

**The logo** you upload is also used to regenerate the app icon that appears when
somebody installs the player on a phone, and the small icon in the browser tab.

### Stream Mode — applies on the next Play

**What it does.** Chooses how the music reaches listeners: through the relay, or
directly from your station.

**Do you need it?** Only if the default is wrong for you. Leave it alone unless
you have a reason.

**Full explanation, including the trade-offs:** [docs/listener-modes.md](listener-modes.md#the-two-modes).

### Stream buffer — read-only, and not in the dashboard

**What it is.** How many seconds ahead of the live edge your station buffers.

**Why it is not editable here.** Your station owns that value and publishes it;
this application reads it, and needs it to be right for two things: the countdown
to the end of the track, and the Skip button's end-of-track lock. A value you
could set in two places is a value that will eventually disagree with itself, and
when it does, the countdown is wrong and Skip cuts into the next song.

**To change it,** change it in your station. It appears in the dashboard
read-only, so you can see what it currently is.

### Skip Control — applies on the next page load

**What it does.** Decides who sees the Skip button on the player.

| Option | Who sees it |
|---|---|
| Always hide | nobody except you |
| Show when solo | only listeners who are the only person listening — **the default** |
| Always show | everyone |

**Do you need it?** No, but you will probably want to change it. "Show when
solo" is a good default: it lets a listener skip a track they dislike when
nobody else is listening, without letting them cut a track off an audience.

**Admins always see Skip**, whichever option is set. You run the station, and it
can be on air with nobody listening locally — so the rule about not cutting
people off should not stop you.

**Why the button and the server agree.** The player decides whether to draw the
button, and the server separately decides whether to act on it, and both read the
same rule. That is deliberate: a Skip button that the server ignores is worse
than no button at all.

### Maintenance Mode — applies immediately

**What it does.** Replaces the player with a notice and a message you write.

**Do you need it?** Only when you are doing something disruptive. It is a
polite "we're working on it" rather than an outage control.

**Admins still see the working player** while it is on, so you can confirm the
station is fine before you put it up for your listeners.

### Verbose browser logging — applies on the next page load

**What it does.** Prints extra detail to the browser's developer console: what
the station feed returned, what happened to the audio, how track links resolved,
what happened to requests.

**Do you need it?** No, unless somebody reports something odd and you cannot see
their screen. It is genuinely useful then, because it tells you what their
browser is doing rather than what you assume it is.

**Errors are always logged**, whether this is on or off.

### Explicit tag — applies immediately

**What it does.** Appends a marker to the track title shown in your phone's lock
screen or music controls, for tracks with explicit lyrics.

**Do you need it?** Entirely your call. Some listeners find it useful; some find
it annoying.

---

## People and permissions

### Approving listeners

**What it does.** Decides who can hear the station.

A new sign-in arrives as **pending**. A pending listener cannot hear any audio —
there is no preview and no trial period. You either approve them or they hear
nothing.

**Do you need it?** Yes, this is the core of the gate. Without it, anybody who
can find your URL and sign in with any Google account could listen.

### Approve, revoke, remove

- **Approve** grants access. The person can listen immediately.
- **Revoke** takes access away but keeps the account and its history. Use this
  for somebody who should not listen right now but whose likes you want to keep.
- **Remove** deletes the account, and with it their sessions, requests, likes and
  presence. Use this for somebody who should not be here at all.

Both take effect immediately — there is no delay and no cached session to wait
out.

### Per-listener permissions

Four separate grants, each off by default, each switched on or off per person:

| Grant | What it gives them |
|---|---|
| **Admin** | the whole dashboard, and everything below |
| **Manual Voice DJ** | the box on the player where they can write lines for the AI DJ to say |
| **Approve users** | the approve and revoke buttons, so they can let others in |
| **Run DJ skills** | the skills feature, where they can ask the AI DJ to do a task mid-show |

**Admin includes the other three.** They appear greyed out for an admin rather
than being separately switchable, because two places recording "is this person an
admin" is two places that will eventually disagree.

**Do you need any of these?** No. Everyone is a plain approved listener until you
say otherwise, which is the right starting point.

### Nicknames

**What it does.** Gives a listener a display name, used on their likes and
wherever their name appears.

**Do you need it?** No. Listeners can set their own from the Account menu.

**Can a listener hide their name on likes?** Yes, and it is their choice, under
**Account → Hide name on likes**. Not a permission you control.

---

## Sub/Wave station

How this application connects to your station. All of these apply immediately and
none of them need a restart.

### API base URL

**What it is.** The public web address of your SUB/WAVE station. The browser uses
it to fetch the current track and its cover artwork.

**Must be public.** Not `localhost`, and not a private home network address —
one starting `192.168.` or `10.` is for machines on your own network and means
nothing to anyone else. Your listeners' own browsers fetch some of this
directly, from their own homes, so it has to be reachable from the internet.
`/api` is added for you if you leave it off.

**Do I need it?** Yes.

### Relay stream URL

**What it is.** The address of your Icecast relay — the thing that re-sends your
station's audio to many listeners. It usually runs on the same server as this
application, which is why it is usually `127.0.0.1`.

**Must be the relay, never your station.** This is the single most consequential
setting on the page. If you point it at your station instead, every listener
opens their own connection to your station, and your station's upload will not
cope with more than a handful of people. That is the exact problem the relay
exists to solve.

**Do I need it?** Yes, unless you are using direct stream mode.

### Admin username and password

**What they are.** Your station's own administrative credentials. They authorise
the two things listeners can do that change something: skipping the current
track, and permanently blocking a track, album or artist from ever playing
again.

**Do I need them?** Yes, or those two features will fail.

### Station password

**What it is.** The password listeners' audio connections authenticate with.

**This one must match in three places**, and drift between them is the single
most common cause of "the page works but there is no sound":

1. Here, in **Station Password**
2. The master password in your relay's configuration
3. The listener password in your station's own settings

**What happens when you save it here.** This application repoints your relay's
master password to match. If audio stops immediately after saving, this is the
first thing to check — the other two places still need updating by hand.

**How to compare them without printing them.** Compare hashes, not values:

```bash
sha256sum
```

Paste each password in on its own, one at a time, and check the hashes match.
Never paste a real password into a chat, an issue, or a screenshot.

---

## Support and donations

### Support Button

**What it does.** The tip button on the player — its text and where it goes.

**Do I need it?** No. With it off and no tips ever received, the button stays
hidden, so a new station does not show an empty donations panel.

### Webhook secret

**What it is.** A secret string that Buy Me A Coffee gives you. When somebody
tips you, they send this application a notification, and the secret proves the
notification really came from them.

**Do I need it?** Only if you want tips. Without it, no tip notification is
accepted at all — the application refuses everything rather than trusting
everything, which is the correct way round.

**Where to get it.** Your Buy Me A Coffee dashboard, **Settings → Webhook**. Copy
it and paste it here. It must match exactly.

**The address to give Buy Me A Coffee:**

```
https://your-station.example.com/api/webhooks/bmac
```

That address is reachable without anyone being signed in, because the sender is
the internet and cannot hold a session. The signature is what proves the
notification is genuine. It is one of only three exceptions to the sign-in
requirement, and all three are documented in the code.

**Buy Me A Coffee is the only service supported.** The code that receives these
notifications understands their format and nobody else's.

### Donations

**Where they are listed.** Under **Admin → Stats**, not here, with a link back
to this section. Only you can see them.

---

## Google sign-in

**What it does.** Client ID, client secret, and the email address that becomes
the administrator.

**Do I need it?** Yes. Without Google credentials, nobody can sign in, so nobody
can listen.

**Why saving restarts the application.** These are read once, when the process
starts, so there is no way to apply them to a running process. The dashboard
restarts it for you.

**`Admin Email` cannot be changed to somebody else later.** A sign-in matching
this address is *automatically* an administrator, and it is the only way to
become one. If you set it to an address you do not control, you have made an
outsider an administrator without meaning to.

**The redirect URI to register with Google** is exactly:

```
https://your-station.example.com/api/auth/callback/google
```

No trailing slash. Step-by-step setup, including the consent screen, is in
[docs/deployment.md](deployment.md#step-8--first-sign-in).

---

## Push notifications

**What they are.** Phone notifications to you, the operator — for example when
somebody sends a tip.

**How they work.** A cryptographic key pair identifies your server to your phone.
The browser on your phone holds the public half; the private half never leaves
your server.

**Do I need them?** No. Entirely optional.

**If you want them**, generate a key pair:

```bash
npx web-push generate-vapid-keys
```

Paste the pair into the dashboard, along with a `mailto:` contact address so the
keys have an owner.

**Applies immediately.**

**One thing to know before you rotate them.** Changing the keys orphans every
phone already subscribed — they will not receive anything until they re-subscribe,
which happens the next time you open the dashboard on that device. Dead
subscriptions tidy themselves up on their own.

---

## Music links

**What it does.** Makes the Spotify link on each track go to the actual track
rather than to a search.

**What happens without it.** Every track still gets a link — it just opens a
Spotify search for that track's name instead of the track itself. Apple Music
links are always exact and never need credentials.

**Do I need it?** No.

**If you want it**, create a free app in the [Spotify developer
dashboard](https://developer.spotify.com/dashboard) and paste the client ID and
secret here. Five minutes, no billing, and no redirect URL to configure — it uses
a server-to-server token, so nothing ever opens in a browser.

---

## Skills

**What they are.** Short tasks the AI DJ can be asked to perform mid-show — the
"DJ skills" your station makes available.

**Who gets them.** Whichever listeners you grant it to. **Nobody, by default.**

**How the off switch works.** A listener without the grant does not see the
feature *at all* — it is not in their page, rather than being there and greyed
out. The server refuses them as well, independently. Hiding something is not the
same as protecting it, so both happen.

**Where the list comes from.** Your station. Whatever it has switched on and can
actually run is what appears here. There is no second list here to keep in sync,
so switching a skill off in your station removes it from the player.

**What it costs.** Nothing to enable. Each run uses your station's own
configuration.

**Why runs are not held open in the browser.** A skill run takes roughly 45
seconds — that is your AI DJ thinking and then speaking. Holding a browser
request open for that long is fragile: proxies and phones both give up first.
So the run is queued and a background worker on your server carries it out, and
the browser is told when it is done.

**What the browser is told about a skill.** Its name, a one-line description, and
nothing else. Not the instructions it runs, and not its settings.

---

## Settings that are not in the dashboard

Four values have no dashboard control, on purpose. Each is either needed before
the application can answer a request at all, or is a property of your server
rather than of your station.

### `NEXTAUTH_SECRET`

Signs the cookies that keep people signed in.

```bash
openssl rand -base64 32
```

**Why it is not in the dashboard.** Changing it logs every listener out, and
there is no recovery path in a web page — which is exactly why it should not be
one. It has to be in the configuration file, where changing it is deliberate.

**Keep it the same across restarts.** If it changes every time the server starts,
people are signed out constantly.

### `DATABASE_URL` and `DB_PROVIDER`

**Why they are not settings.** Moving the database is a migration, not a
preference. It has to copy data, check the copy, and only then switch — none of
which belongs in a form that saves on click.

**How to move instead.** The **Database** tab in the dashboard. See
[docs/deployment.md](deployment.md#moving-to-postgres).

### `PM2_APP_NAME`

The name your process manager knows this application by. The dashboard restarts
the application through that name when you save your identity, your Google
details, or move databases.

**Why there is no default.** The name belongs to your server, not to the software.
A default would be wrong twice over: it goes stale the moment you rename the
process, and it quietly ties general-purpose software to one particular station.

**What happens if it is unset.** The dashboard refuses to save anything that
needs a restart, *before* changing anything, and tells you why. It does not
report a restart that would silently never have happened.

`PM2_BIN` sits alongside it for the same reason — a bare `pm2` is not reliably
on the `PATH` a background service gets.

### `PII_ENCRYPTION_KEY`

The key that encrypts every name, email address and tip in your database.

```bash
openssl rand -hex 32
```

**Why it is not in the dashboard.** It cannot be changed. Changing it would make
every existing record unreadable, and there is no way to re-encrypt them from a
web page.

**If you lose it, the data is gone.** Not hidden — gone. Back it up somewhere
other than the database, which is the entire point of encrypting: a stolen
database file on its own is worth nothing without this key.
