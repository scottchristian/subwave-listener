# Contributing

Thanks for looking. This is a small codebase with a few strong opinions, mostly
earned the hard way — the notes below are the ones that will otherwise cost you
an afternoon.

- [Getting set up](#getting-set-up)
- [Branching](#branching)
- [Commits](#commits)
- [Pull requests](#pull-requests)
- [Conventions that matter here](#conventions-that-matter-here)
- [Running the checks](#running-the-checks)
- [Things that will bite you](#things-that-will-bite-you)
- [Reporting a bug](#reporting-a-bug)

---

## Getting set up

You need **Node.js 20.9 or later** (Next 16's floor) and a SUB/WAVE station to
point at. A public or otherwise throwaway one is fine for development.

```bash
git clone https://github.com/scottchristian/subwave-listener.git
cd subwave-listener
npm install
cp .env.example .env.local
```

Fill in `.env.local` — [deployment.md](docs/deployment.md#step-4--configure-it-wizard-or-by-hand) walks
through it. The two that block a local start are `PII_ENCRYPTION_KEY` and the
Google credentials; everything else can stay at its example value until you want
to see it work against a real station.

```bash
set -a; . ./.env.local; set +a
npx prisma generate
npx prisma migrate deploy
npm run dev
```

If you already had a local `data/station.db` from an earlier version, `migrate
deploy` stops with `P3005` and "The database schema is not empty" rather than
touch your rows. Point it at the schema you already have:

```bash
npx prisma migrate resolve --applied 20260924000000_baseline
```

To start over instead, delete `data/station.db` and run `migrate deploy` again.

**There is no test suite and no CI.** Not yet — that is a known gap, not an
oversight, and a PR that adds one would be welcome. Until then, the checks below
plus a real browser are the safety net, and they are not optional: most of the
code here is a browser talking to a live audio stream, and the interesting bugs
only show up when you actually load the page.

---

## Branching

Two long-lived branches:

- **`main`** — what people run. Only receives work that is finished and agreed.
- **`develop`** — where work lands. This is the default branch of the upstream
  project too, so muscle memory transfers.

Branch from `develop`, and keep it short. Commit directly to `develop` if the
change is small and obvious; open a pull request when you want a second pair of
eyes, or when the change is large enough that you would rather not be the only
person who knows what it did.

Merging to `main` is the maintainer's call and happens when the work looks
right, not when a milestone ticks over.

---

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary in the imperative>
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `chore`.

```
feat(skip): let operators choose who sees the Skip button
fix(stats): count bundled sessions instead of socket rows
docs(deployment): explain the SQLite file: path gotcha
```

Scopes are the area: `auth`, `db`, `skills`, `skip`, `stream`, `webhook`,
`admin`, `player`, `pii`, `docs`.

**Write the body for someone reading `git blame` in two years**, because that is
who reads it. Say what was broken and why the obvious fix was wrong. A commit
message that only says what changed throws away the reasoning, and the reasoning
is the part that was expensive:

> The people roster reported 5363 plays for an account that had started the
> stream a few dozen times. The count was raw socket rows, incremented before
> the validity check, so rows orphaned by deploys each counted as a play while
> contributing no time. 4928 of that 5363 were exactly that.

Keep the summary line under ~72 characters and in the imperative. One logical
change per commit — a commit that does three unrelated things cannot be reverted,
bisected or reviewed.

---

## Pull requests

- Branch from `develop`.
- Explain **what changed and why**, and what you tried that did not work. The
  second half is often the more useful half.
- Say how you checked it. "Loaded the player, pressed Play, listened" is a real
  answer.
- Note anything you deliberately did not do, and why.
- Update the docs in the same commit as the change. A setting with no
  documentation is a setting nobody can find.

---

## Conventions that matter here

### Every interactive element gets an `id`

No exceptions — buttons, links, inputs, toggles, containers with state. The
admin dashboard is driven by people and by agents pointing at elements by id, so
an unlabelled control is a control nobody can reach.

Ids are `btn-`/`input-`/`toggle-`/`section-` plus what it does: `btn-skip-track`,
`input-request-song`, `section-support-settings`. A full id audit should find no
duplicates.

### Never commit secrets

`.env*`, `data/` and `*.db` are gitignored. Keep them that way. `PII_ENCRYPTION_KEY`
and `NEXTAUTH_SECRET` in particular — a leaked `NEXTAUTH_SECRET` lets anyone
forge a session, and a leaked `PII_ENCRYPTION_KEY` defeats the encryption of
every name, email and donation in the database.

### Never commit deployment detail

Not a hostname, not an IP address, not a path on someone's server, not a
database URL. This is general-purpose software for other people's stations; your
deployment's details are not part of it, and a public repository publishes them
to everyone who ever finds the URL.

`npm run check:refs` enforces this for the documentation. It failed once already,
for real, which is why it exists.

### Write for somebody who has never seen this

The documentation is read by station operators, not only by developers, and many
of them are running this on a home network for the first time. Assume none of the
following:

- that they know what a reverse proxy, a port forward, CGNAT, a process manager
  or a connection pooler is
- which parts are optional and which are not
- that the step you just described is the step that breaks

Concretely:

- **Say what a thing is, why it is there, and what happens without it.** Not
  "configure nginx" but "nginx is a web server that terminates encryption and
  holds open connections; without it your application is exposed directly and
  browsers will warn about it".
- **Mark optional things as optional**, plainly. Somebody should be able to read
  a section and conclude they can skip it.
- **Spell out the commands.** `cp .env.example .env.local`, not "copy the example
  file". Name the file the reader will end up editing, and how to open it.
- **Explain the traps inline**, at the point where the reader would hit them,
  rather than in a section they have to know to look for. The Prisma CLI not
  reading `.env.local`, and `file:` paths being relative to the schema file, are
  both documented at the step where they bite.
- **Use `example.com` and RFC 5737 addresses** (`203.0.113.x`) for every example,
  never a real one.

### Keep the operator's secrets out of responses

Encrypted columns are never returned to a browser, and no route hands out a
stored ciphertext or a blind index. If you add a route that returns personal
data, it must decrypt deliberately — `dec`, or `displayName`/`displayEmail` from
`lib/pii.ts`. `npm run check:pii` fails on the unambiguous cases.

### A hidden control is not access control

Every permission is enforced server-side, independently of what the UI renders. A
listener without the skills grant does not see the entry point — *and* the API
refuses them. Both, always.

### One source of truth per value

When a decision is shared between client and server, put it in one module and
have both read it. `lib/skipvisibility.ts` exists because the player rendering a
Skip button the server would refuse is worse than not rendering it. The same
reasoning gave us `lib/pm2app.ts` and `lib/station.ts`.

If a value is owned by SUB/WAVE — the stream buffer, for instance — read it and
do not offer to change it here. A value editable in two places is a value that
will disagree.

### Comment the non-obvious, not the obvious

The comments in this codebase explain *why* something is the way it is, usually
because the obvious version was tried and broke. That is what earns its keep.
Restating what the line does does not.

---

## Running the checks

```bash
npm run typecheck     # tsc --noEmit
npm run check         # check:pii + check:refs + check:links
npm run check:pii     # no encrypted column reaches a response
npm run check:refs    # no real address/hostname/ssh target in the docs
npm run check:links   # every local link, anchor and image in the docs resolves
npm run build         # the real check — no CI means this is the gate
```

`check:links` exists because a broken cross-reference is the quietest
documentation failure there is: the page still renders, the reader just gets sent
to the top of a page that does not contain what they were sent for.

`npm run build` on its machine is not a substitute for `npm run build` on the
deployment. `NEXT_PUBLIC_*` values are compiled in at build time.

**If you change a setting, update `docs/settings.md` in the same commit.**

---

## Things that will bite you

**`proxy.ts` is ignored silently if Next does not recognise it.** Next 16 renamed
the middleware convention; the file must be `proxy.ts` and the exported function
must be named `proxy`, or it is skipped with no error. An ignored auth gate fails
**open**. If you touch authentication, test it from outside: request an API route
with no cookie and confirm you get `401`, not data.

**Do not use `getToken` to read the session cookie.** That helper decrypts a
JWE, which is only what the cookie holds under `strategy: "jwt"`. This app uses
`"database"`, where the cookie is a bare session token. `getToken` rejects every
real user while looking correctly closed to anonymous callers — which is a
particularly nasty failure, because the anonymous path still works.

**The Prisma CLI does not read `.env.local`.** It reads `.env` and
`prisma/.env`. Use `set -a; . ./.env.local; set +a` first, or every Prisma
command fails with `Environment variable not found: DATABASE_URL`.

**`file:` SQLite paths are relative to `prisma/schema.prisma`,** not the project
root. `file:./data/app.db` lands in `prisma/data/`.

**Prisma bakes the datasource provider into the generated client.** A client
generated from the SQLite schema cannot talk to Postgres even when
`DATABASE_URL` says otherwise, and every query then fails at runtime. The
cutover rewrites the schema and `DB_PROVIDER` together; if you ever generate a
client by hand, generate it from the schema for the provider you are actually
running.

**Next 16 renamed `middleware` to `proxy`, and the file must not be both.**

**There is no `middleware.ts`.** If you find yourself creating one, you are about
to have two auth gates, one of which is ignored.

**The app runs as an unprivileged account, and one command needs sudo.**
Deployments use a `subwave-listener` system user; the dashboard's rebuild-and-
restart actions go through pm2 *as that user*, which is why they work. Reloading
Icecast is the single exception — it needs root, so `lib/relay.ts` calls
`sudo -n /usr/bin/systemctl reload icecast2` when it is not running as root, and
`systemctl` directly when it is. Both paths work.

Two things depend on that staying narrow. The sudoers rule is
`/etc/sudoers.d/subwave-listener` and must permit **only** that one command —
widening it to `systemctl *` hands the web process root back through the front
door. And if you add another privileged operation, it needs an equally narrow
rule and a comment saying why; the default answer to "should this need root?" is
no.

The setup wizard can also perform this handover itself, on a root install — see
`lib/handover.ts`. Two things about it are load-bearing. It is offered only when
there is a pm2 process to hand over, because half-changing a server and then
being unable to finish is worse than not offering it. And it runs every
fallible step before the one irreversible step, undoing them on failure; only
the process swap cannot be undone, which is why it happens last and the operator
is warned first. `scripts/check-setup.mjs` covers the decision logic, including a
case that fails if the sudo rule is ever widened.

Also note that `sudo` is called with `-n` on purpose. Without it, a missing rule
makes sudo try to prompt for a password, and a process with no terminal hangs
instead of failing. That is a bad failure mode to add to a request handler.

---

## Reporting a bug

Open an issue with:

- What you did, what you expected, what happened.
- Your Node version and whether you are on SQLite or Postgres.
- Relevant console or `pm2 logs` output — with anything secret removed.
- Whether it reproduces on `develop`.

If it involves audio, say whether metadata still updates. "Artwork and track
title are fine, no audio" and "nothing loads at all" are different bugs with
different causes, and that distinction usually saves a round trip.

**Never paste a real station password, webhook secret, database URL or
`PII_ENCRYPTION_KEY` into an issue.** If you need to show one, show its shape
with the value replaced.
