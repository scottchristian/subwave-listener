# Deploying Subwave Listener

Getting the player onto a server where your listeners can reach it, keeping it
running, and looking after it afterwards.

- [What you need first](#what-you-need-first)
- [Step 1 — Choose a server](#step-1--choose-a-server)
- [Step 2 — Point your domain name at it](#step-2--point-your-domain-name-at-it)
- [Step 3 — Install Node.js and the code](#step-3--install-nodejs-and-the-code)
- [Step 4 — Create the configuration file](#step-4--configure-it-wizard-or-by-hand)
- [Step 5 — Create the database](#step-5--create-the-database)
- [Step 6 — Put nginx and a certificate in front](#step-6--put-nginx-and-a-certificate-in-front)
- [Step 7 — Run it as a service account, and keep it running](#step-7--run-it-as-a-service-account-and-keep-it-running)
- [Step 8 — First sign-in](#step-8--first-sign-in)
- [Moving to Postgres](#moving-to-postgres)
- [Branding](#branding)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [Checking a deploy worked](#checking-a-deploy-worked)
- [Troubleshooting](#troubleshooting)

---

## What you need first

The [README](../README.md#what-you-need-before-you-start) explains every piece
of software involved — what it is, why it is there, and what happens without it.
In short, before starting here you need:

| | Required? |
|---|---|
| A server with a public address | **Yes** |
| A domain name pointing at it | **Yes** |
| Node.js 20.9 or newer on that server | **Yes** |
| Google sign-in credentials | **Yes** |
| A SUB/WAVE station, already running | **Yes** |
| An Icecast relay | Strongly recommended |
| Postgres | No — SQLite is the default |
| Buy Me A Coffee, Spotify, a network overlay | No |

**Two things to sort out before you start**, because they are the ones that cause
the most confusion later.

**Your station's public address.** This application asks your station for the
track information and for cover artwork, and your listeners' browsers ask for
some of it directly. So it must be an address the wider internet can reach —
not a private home network address, and not `localhost`. If your
station is at home and you do not yet have a way to reach it from a server, read
[the reachability section of docs/listener-modes.md](listener-modes.md#network-reachability-between-the-player-and-the-station)
first.

**Whether your server can reach your station.** The reverse of the above, and
much more often already true: the application dials *out* to your station and
never needs your station to dial in. If a browser on your server's network can
open your station's web address, you are fine.

---

## Step 1 — Choose a server

Any small Linux server will do. This is a small application; a machine with
about 1 GB of memory is comfortable.

The usual choice is a small **VPS** — a virtual private server rented by the
month from a provider. It is a good fit because this application needs two
things a home connection is awkward about: a public address, and a real SSL
certificate. A VPS gives you both easily and cheaply.

Ubuntu 22.04 or 24.04 is what the steps below assume. Debian works the same way.

> **A note on cost.** Everything here is free software. The only things you may
> pay for are the server itself (a few dollars a month from most providers) and,
> optionally, a managed Postgres and the domain name.

---

## Step 2 — Point your domain name at it

Your listeners will use an address like `https://station.example.com`, so that
name has to reach your server.

1. Buy a domain name, or use one you already have. Any registrar works.
2. In your DNS settings, add an **A record** (for IPv4) and an **AAAA record**
   (for IPv6) both pointing at your server's IP address. Add whichever your
   server has; adding both is fine if it has both.
3. Wait for it to take effect. Usually a few minutes, occasionally a few hours.

Check it worked:

```bash
ping station.example.com
```

You should see your server's address. If you get "cannot resolve", DNS has not
propagated yet — wait and try again.

> **IPv4, IPv6, or both.** It makes no difference to this application; it dials
> out and does not care which version of the protocol it is using. Point DNS at
> whichever your server has, and configure the web server for whichever you
> pointed at.

---

## Step 3 — Install Node.js and the code

Log in to your server. Most providers give you a web console; otherwise use SSH
from your own machine:

```bash
ssh root@your-server-address
```

If you would rather not use `root`, create a normal user and `sudo` from there —
but then every command below that writes to `/etc` or starts a service needs
`sudo` in front of it.

### Install Node.js

Node.js is what actually runs this application. Install the current **22.x**
release, which is comfortably above the 20.9 minimum:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

Check it:

```bash
node --version
npm --version
```

### Get the code

```bash
apt install -y git
cd /srv
git clone https://github.com/scottchristian/subwave-listener.git
cd subwave-listener
npm ci
```

`npm ci` installs exactly the versions the project pinned, which is what you
want on a server. It takes a minute or two.

> **Build on the server, never on your own machine.** Everything named
> `NEXT_PUBLIC_*` is compiled into the code the browser downloads, at the moment
> you build. Your real values exist only in this server's configuration file. A
> build made on your laptop ships *your laptop's* values — the wrong station
> name, the wrong logo, the wrong address — and looks perfectly fine while doing
> it.

---

## Step 4 — Configure it (wizard, or by hand)

### The short way: let the wizard do it

If you have not configured the application yet, skip this step entirely. Get it
running with four commands and open the browser:

```bash
git clone https://github.com/scottchristian/subwave-listener.git
cd subwave-listener
npm install
npm run build && npm start
```

Then go to **`/setup`**. The wizard asks for the Google details, chooses and
creates your database, sets your station's name, and writes its own configuration
file — including generating the two keys you would otherwise have to make with
`openssl`.

Two things to know about it:

- **It runs before a database exists.** The application starts without one on
  purpose, because that is what lets the wizard create it. If the database step
  is skipped and nothing is configured, that is expected.
- **It closes itself when it finishes**, and it is then unreachable. It writes
  your Google credentials, so leaving it open would let anyone who found the
  address repoint the station at their own account. To run it again — to change
  your Google credentials, for instance — delete `.setup-complete` from beside
  your `.env.local` and restart.

**An already-configured station is never exposed to it.** On boot the
application checks whether it already has secrets, Google credentials and a
database; if it does, it writes the marker itself and the wizard stays closed.
That matters because the upgrade to a version *containing* the wizard would
otherwise publish an unauthenticated page on a station that was set up before it
existed.

**If the wizard is running as root**, it says so on the first screen — in fairly
plain terms — and offers to fix it. Two routes, both first-class:

- **"Set it up for me."** The page creates the service account, grants it the one
  permission it needs, hands over the application directory, and restarts the
  application as that account. Your browser loses the page for a few seconds
  while the old process is replaced; it comes back when the new one is up.
- **"I'll do it myself."** It prints the exact commands, with a copy button, and
  tells you to come back to `/setup` afterwards — which picks up exactly where you
  left off.

Nothing about the rest of setup depends on this, so it is never blocking. Do it
now or after, whichever suits.

### What the handover does, and what it will not do

The order matters, and it is arranged so that everything which can fail happens
before the one thing that cannot be undone:

1. create the account (no password, no login shell)
2. add it to the group that owns the relay config, and make that config writable
3. write one sudo rule — **validated with `visudo -c` before it is trusted**
4. hand over the application directory, and protect `.env.local`
5. restart the application as that account

If any of the first four fails, the wizard undoes what it did and says what went
wrong. Only step 5 is irreversible from here, which is why it happens last, and
why you are warned before it starts.

**The sudo rule is scoped to one command** — `systemctl reload icecast2` — and
the test suite fails if it is ever widened to `systemctl *` or bare `NOPASSWD`.
That is the entire security property, and it is checked rather than trusted.

**The automated route is only offered when it can work.** If the application was
not started by pm2, there is no process for the page to hand over, so it says so
and prints the commands instead, rather than half-changing your server.

**Reverting.** Every command set shown includes its own undo, and the automated
route returns one too if it fails after the directory handover.

### The long way: configure it by hand

Everything the wizard does is a normal environment variable, and doing it by
hand is a perfectly good choice — you can see and change everything, and you can
re-run it.

Copy the template, which documents every setting inline:

```bash
cp .env.example .env.local
nano .srv/subwave-listener/.env.local
```

In `nano`: type to edit, **Ctrl + O** then Enter to save, **Ctrl + X** to exit.

On a server without `nano`, `vi` works — press **i** to edit, type
`:wq` and Enter to save and quit.

The template has around thirty settings, each with a comment explaining it. Most
can stay as they are. Fill in these groups.

### Station identity

How your station presents itself. This appears in the page header, the browser
tab and the sign-in screen.

```
NEXT_PUBLIC_STATION_NAME="My Station"
NEXT_PUBLIC_STATION_TAGLINE="Broadcasting beyond boundaries."
NEXT_PUBLIC_STATION_DESCRIPTION="A private internet radio station with an AI DJ."
NEXT_PUBLIC_STATION_ABOUT="A private internet radio station. Access is by invitation only."
NEXT_PUBLIC_STATION_LOGO="/brand/logo.png"
```

### Your addresses — read this part twice

Four addresses, and mixing them up is the single most common cause of a station
that loads but shows nothing.

```
# The public address of your SUB/WAVE station. NO /api at the end.
# This one is used by listeners' browsers, so it must be reachable by the internet.
NEXT_PUBLIC_BACKEND_URL="https://radio.example.com"

# The same address, server-to-server, WITH /api. Used for requests, skips and
# anything that changes something.
SUBWAVE_API_URL="https://radio.example.com/api"

# Your Icecast relay — the thing that re-sends your station's audio to listeners.
# It usually runs on this same server, which is why it is localhost.
SUBWAVE_STREAM_URL="http://127.0.0.1:8000/stream.mp3"

# This application's own public address. No trailing slash.
NEXTAUTH_URL="https://station.example.com"
```

> **`SUBWAVE_STREAM_URL` must be your relay, never your station.** Pointing it
> at the station directly means every listener opens their own connection to
> your station — the exact thing the relay exists to prevent. Your station's
> upload will not survive it.

### The two keys you generate

```bash
openssl rand -base64 32     # → NEXTAUTH_SECRET
openssl rand -hex 32        # → PII_ENCRYPTION_KEY
```

```
NEXTAUTH_SECRET="paste-the-first-output-here"
PII_ENCRYPTION_KEY="paste-the-second-output-here"
```

**`NEXTAUTH_SECRET`** signs the cookies that keep people signed in. Changing it
logs everybody out. There is no way to recover it from the application, which is
exactly why it is not something you set from a web page.

**`PII_ENCRYPTION_KEY`** encrypts every name, email address and tip in your
database. It has to be exactly 32 bytes.

> **Back up `PII_ENCRYPTION_KEY` somewhere else immediately.** A backup of your
> database without this key is unreadable — by you and by anyone who steals it.
> That is the point of encrypting, but it also means there is no recovery. Put a
> copy in a password manager.

### The database

Leave these as they are unless you are following [Moving to Postgres](#moving-to-postgres).

```
DB_PROVIDER="sqlite"
DATABASE_URL="file:../data/app.db"
```

> **A `file:` path is relative to `prisma/schema.prisma` inside the project, not
> to the folder you are standing in.** `file:./data/app.db` lands in
> `prisma/data/`, which is not where anything else expects it. Use
> `file:../data/app.db` — two dots — for a `data` folder alongside the project.
> An absolute path such as `file:/var/lib/subwave/station.db` sidesteps the
> question completely.

### Process name

```
PM2_APP_NAME="subwave-listener"
```

This is the name your process manager will know the application by. There is
deliberately no default: the name belongs to your server, not to the software,
and a wrong one means a restart that silently never happens. The dashboard
refuses to save anything that needs a restart while this is unset, rather than
reporting a restart that did not occur.

Save and exit.

---

## Step 5 — Create the database

Two commands:

```bash
cd /srv/subwave-listener
set -a; . ./.env.local; set +a
npx prisma generate
npx prisma migrate deploy
```

**Why the middle line?** Next.js reads `.env.local`. The database tool reads a
file called `.env` — a different name — and cannot see your values. That line
loads your file into the shell so the database tool can find it. Without it you
get `Environment variable not found: DATABASE_URL`, which is the single most
common error in this whole guide.

`migrate deploy` creates the database and its tables. It is safe to run again at
any time — it only applies anything not already applied.

> **Already got a database from an earlier version?** Then this step refuses,
> with `P3005` and "The database schema is not empty". That is the database tool
> protecting your data: it will not replay a schema over tables that already hold
> donations and listeners. Tell it the schema is already there instead:
>
> ```bash
> npx prisma migrate resolve --applied 20260924000000_baseline
> ```

> **This step is for SQLite only.** If you are using Postgres, skip it. The
> migrations in this project are written for SQLite and will not work on
> Postgres; see [Moving to Postgres](#moving-to-postgres).

---

## Step 6 — Put nginx and a certificate in front

Right now the application is running on port 3000 on your server, and nothing
is listening on port 443. Two things fix that.

### What nginx is, and why

**nginx** is free web server software. Its job here is to stand in front of your
application and do three things a raw Node.js process should not:

1. **Terminate encryption.** Decrypting HTTPS properly — and keeping the keys
   safe and renewed — is fiddly. Doing it once, in one well-tested program, is
   better than doing it in your application.
2. **Serve many simultaneous listeners.** A radio station with a few hundred
   people listening is a few hundred open connections. nginx handles that
   comfortably.
3. **Refuse everything except your application.** Only nginx is exposed to the
   internet; your application stays on `127.0.0.1`, where nothing outside the
   server can reach it.

### Install nginx

```bash
apt install -y nginx
systemctl enable --now nginx
```

### What a certificate is, and why

An **SSL certificate** is what puts the padlock in the browser's address bar.
Browsers now warn loudly on any page without one, so a station without a
certificate is a station people will not trust. A certificate is also what turns
`http://` into `https://` — the encrypted version, without which sign-in
credentials would cross the internet in the clear.

You do not buy one. **[Let's Encrypt](https://letsencrypt.org)** is a free,
widely trusted certificate authority that issues them automatically, and
**certbot** is the tool that asks for one and installs it. It renews itself
every couple of months with no action from you.

### Get a certificate

Point your domain at the server first (Step 2) and wait for DNS to settle, then:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d station.example.com
```

It asks for an email address (for expiry warnings) and a couple of yes/no
questions. When it finishes, your site is on HTTPS and renews itself.

### Configure nginx

certbot writes a basic configuration. Replace it with this one, which is tuned
for a radio station:

```bash
nano /etc/nginx/sites-available/subwave-listener
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name station.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name station.example.com;

    ssl_certificate     /etc/letsencrypt/live/station.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/station.example.com/privkey.pem;

    # Branding uploads are file uploads, which are bigger than the 1 MB default.
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        # Deliberately $remote_addr and NOT $proxy_add_x_forwarded_for. The
        # latter appends to whatever the browser claimed, so a listener could
        # put any address they liked into their own forwarded identity.
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";

        # A radio stream never ends, and must be passed straight through.
        # Buffering adds seconds of delay; the default 60-second timeout cuts
        # a quiet passage off in the middle of a track.
        proxy_buffering         off;
        proxy_request_buffering off;
        proxy_read_timeout      24h;
        proxy_send_timeout      24h;
    }
}
```

> The `listen [::]:` lines are IPv6. Keep both if your server has IPv4 and IPv6,
> and delete the `[::]` lines if it has only one — nginx does not need both.

Enable it and reload:

```bash
ln -sf /etc/nginx/sites-available/subwave-listener /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

`nginx -t` checks the configuration before applying it. Always run it. A typo
that stops nginx starting is much worse than a typo that is merely rejected.

> **Keep secrets out of anything nginx writes down.** Your station password is
> sent as a request header, and appears in a URL only for the direct audio
> stream, which has to be a URL because a browser's audio element cannot send
> headers. If you add your own logging, make sure web addresses are not written
> somewhere you do not control.

---

## Step 7 — Run it as a service account, and keep it running

This step does two things: it puts the application under a **process manager**
so it survives a crash and a reboot, and it runs it as an **unprivileged user**
rather than as root.

Do them together. They are easier to get right in one pass, and the second one
changes how the first has to be set up.

### Why not just run it as root

It is the shortest path and it works, but consider what running as root actually
means here. The application has a small, specific privileged surface: when an
operator changes the station password, the app rewrites the relay's configuration
file and asks the audio server to reload.

That endpoint is a **web request**. Anything that obtains an admin session — a
stolen cookie, a cross-site bug, a compromised dependency — can reach it. As root,
the blast radius of that is the whole machine: SSH keys, `/etc/shadow`, every
file. As an unprivileged user with one narrow permission, the same compromise
reaches one config file and one service reload.

This is worth doing, and it is not complicated — but it is a change, not a
switch, because of the two things the app genuinely needs. Handle those first,
then run the rest as a normal user.

### The two things the app needs root for

**1. Signaling the audio server.** Reloading a system service needs root.

**2. Restarting itself.** The admin dashboard rebuilds and restarts the
application when you save your station identity, your Google sign-in details, or
move between databases. It does that by asking the process manager to restart
the process.

Capability 2 needs no privileges at all once you set things up correctly: **run
the process manager as the same user who runs the app.** Then the app asking
pm2 to restart its own process is just a user talking to their own process
manager, which is allowed. This is the elegant part of the whole change.

Capability 1 is the only thing that needs a rule.

### Create the service account

```bash
useradd --system --create-home \
        --home-dir /var/lib/subwave-listener \
        --shell /usr/sbin/nologin \
        --comment "Subwave Listener web player" \
        subwave-listener
id subwave-listener
```

A **system account** is one that exists to own a service rather than for a person
to log in with, so it has no password and no login shell. It does need a home
directory, because that is where the process manager keeps its state — without
one, `pm2` has nowhere to put its socket and the app cannot restart itself.

> Name it after the software, not after the station. The account is a property of
> the software's deployment, so `subwave-listener` is right and a station name
> would be wrong twice over.

### Give it permission to write the relay configuration

The relay's config file is usually `root:icecast` with mode `640` — the group can
read but not write. Add the service account to that group, and let the group
write:

```bash
usermod -aG icecast subwave-listener
chmod 660 /etc/icecast2/icecast.xml
```

Check which group actually owns it before you change it:

```bash
stat -c '%A %U:%G %n' /etc/icecast2/icecast.xml
```

**What this does and does not allow.** The app can now rewrite that one file. It
does not get to choose which file — the path is fixed in the code — so this
grants "change the relay's master address and password", not "edit any config on
the machine". It is a real capability, and it is much less than root.

### Give it permission to reload the audio server, and nothing more

```bash
nano /etc/sudoers.d/subwave-listener
```

```
# The web player rewrites the Icecast relay password when an operator changes
# the station password, and asks Icecast to reload.
#
# Scoped to this ONE command. Do not widen it to "systemctl *" or NOPASSWD:
# that hands the web process root back through the front door, which is the
# whole thing you are doing this to avoid.
subwave-listener ALL=(root) NOPASSWD: /usr/bin/systemctl reload icecast2
```

```bash
chmod 440 /etc/sudoers.d/subwave-listener
visudo -cf /etc/sudoers.d/subwave-listener    # must say "parsed OK"
```

**Always use `visudo -c` after editing a sudoers file.** A syntax error there can
lock you out of sudo entirely, and a lockout you discover at the wrong moment is
a bad afternoon.

> **Keep this rule in step with the app.** The application calls `sudo` for this
> command when it is not running as root, and calls it directly when it is — so
> both arrangements work, and the rule is simply ignored if you stay as root.
> Never widen it. The single narrow command is the entire security property here.

### Hand over the application directory

```bash
chown -R subwave-listener:subwave-listener /srv/subwave-listener
chmod 600 /srv/subwave-listener/.env.local
```

**Do not skip the `chmod`.** `.env.local` holds `NEXTAUTH_SECRET`,
`PII_ENCRYPTION_KEY`, your Google client secret, your station password and your
Sub/Wave admin password. If it is world-readable — and a file created by an
ordinary `cp` usually is — then every process and every user on that machine can
read all of it. Mode `600`, owned by the service account, is the minimum.

### Why pm2

**pm2** keeps a process running, restarts it if it crashes, and brings it back
after a reboot.

**Use pm2 rather than another process manager, for a specific reason.** Three
things in the admin dashboard — saving your station identity, saving your Google
sign-in details, and moving between databases — rebuild and restart the running
application by asking pm2 to. Under any other process manager those three actions
fail, and they fail in a way that looks like the *save* failed rather than the
restart.

### Install and start, as the service account

Install pm2 globally, then start the app **as the service account**, so the two
share a home directory and a process list:

```bash
npm install -g pm2

su -s /bin/bash subwave-listener -c '
  cd /srv/subwave-listener
  set -a; . ./.env.local; set +a
  pm2 start npm --name subwave-listener --time -- start
  pm2 save
'
```

**What the flags mean.** `--name` gives the process a name — the same name you
put in `PM2_APP_NAME`. `--time` prefixes each log line with a timestamp, which is
the difference between a useful log and a mystery. `start` at the end tells pm2
to run the project's `start` script.

**Why `su -s /bin/bash`.** The account has `/usr/sbin/nologin` as its shell, which
is correct for safety. `su -s` overrides the shell just for this command so you
can run setup commands as it.

### Survive a reboot

`pm2 startup` **prints** a command; it does not install anything itself. Copy the
command it prints and run it as root — otherwise you will believe you have a boot
service and you do not.

```bash
su -s /bin/bash subwave-listener -c 'pm2 startup systemd -u subwave-listener --hp /var/lib/subwave-listener'
# it prints something like:
#   sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u subwave-listener --hp /var/lib/subwave-listener
# run THAT, as root:
env PATH="$PATH:/usr/bin" pm2 startup systemd -u subwave-listener --hp /var/lib/subwave-listener
```

Then confirm, and check there is not a second one left over from an earlier
root-based setup resurrecting a duplicate:

```bash
systemctl list-unit-files | grep pm2
```

You want exactly one enabled `pm2-<youruser>.service`. If `pm2-root.service` is
also enabled, turn it off:

```bash
systemctl disable pm2-root.service
```

**Two boot services means two copies of your app fighting over port 3000**, and
the symptom — a page that works sometimes and 502s other times — is miserable to
diagnose.

### Check it is working

```bash
su -s /bin/bash subwave-listener -c 'pm2 list'
su -s /bin/bash subwave-listener -c 'pm2 logs subwave-listener --lines 40'
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000
ps -eo user,args | grep next-server | grep -v grep
```

`pm2 list` should show `online` and a low number in the restart column, the
`curl` should print `200`, and the `ps` line should show the app running as
**`subwave-listener`**, not `root`. That last one is the whole point of this step,
so check it rather than assuming it.

### Prove the privileged paths still work

Everything above can look fine while the two privileged actions are broken, and
you will not find out until somebody changes their station password. Test them
directly:

```bash
# Can it reload the audio server?
su -s /bin/bash subwave-listener -c 'sudo -n /usr/bin/systemctl reload icecast2 && echo ok'

# Can it write the relay config?
su -s /bin/bash subwave-listener -c 'test -w /etc/icecast2/icecast.xml && echo ok'
```

Then, better still, exercise the real endpoint — **Admin → Sub/Wave Server →
Save**. That rewrites the config, reloads the audio server and then fetches the
stream to prove it. A green result there means the whole path works.

### If the app is not root, it cannot be assumed to be able to reload

One failure mode worth knowing: if the sudo rule is missing, `sudo` will try to
ask for a password, and a process with no terminal and no `PATH` will either hang
or fail obscurely. The application therefore runs `sudo` **non-interactively**
(`sudo -n`), so a missing rule fails fast and loudly instead of hanging the
request. If you see a relay sync fail immediately, check the sudoers rule before
anything else.

### Restarting without cutting people off

A restart stops every open player; they reconnect on their own, mid-song. **Admin
→ People** shows who is listening, so you can pick a quiet moment.

Build this into your deploy routine: check the room, then restart, rather than
restarting and discovering afterwards that you interrupted someone.

### If your deploys run as root

Most people push files to the server over SSH as root, with `rsync`. Two things
will then be true after every deploy, and both are worth fixing in the script:

1. **Everything `rsync` writes is owned by root.** The app then cannot write its
   own `.next` directory, and the dashboard's rebuild-on-save silently stops
   working. Add a `chown -R` straight after the sync.
2. **The build runs as root**, which writes root-owned files into the app
   directory. Worse, a root build means the app cannot later rebuild itself. Run
   the build as the service account too.

```bash
# after rsync
ssh user@server "chown -R subwave-listener:subwave-listener /srv/subwave-listener \
  && chmod 600 /srv/subwave-listener/.env.local"

# and run the build itself as the service account
ssh user@server "su -s /bin/bash subwave-listener -c 'cd /srv/subwave-listener && npm run build'"
```

Note that `rsync` must keep excluding `.env.local`. Overwriting it logs every
listener out and breaks sign-in — and if your script also runs a blanket
`chmod`, make sure it does not undo the `600`.

### systemd, if you would rather not use pm2

```bash
nano /etc/systemd/system/subwave-listener.service
```

```ini
[Unit]
Description=Subwave Listener
After=network.target

[Service]
Type=simple
User=subwave-listener
WorkingDirectory=/srv/subwave-listener
EnvironmentFile=/srv/subwave-listener/.env.local
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now subwave-listener
```

**Understand the trade first.** The dashboard's three rebuild-and-restart actions
shell out to pm2 and will not work. Saving your station identity or your Google
details will report that it could not restart, and you restart the service
yourself:

```bash
systemctl restart subwave-listener
```

Everything else — running as an unprivileged user, the sudo rule, the group
membership — works exactly the same. If you would rather those dashboard actions
just work, use pm2.

---

## Step 8 — First sign-in

Open `https://station.example.com`. You will see a sign-in button.

Sign in with the Google account whose address matches the `ADMIN_EMAIL` you set
in Step 4. That account becomes the administrator — it is the only way to become
one, because there is nobody else to grant it to.

If sign-in fails, it is almost always the redirect URI. Compare these two, in
the Google Cloud Console and in your configuration file, character by character:

```
https://station.example.com/api/auth/callback/google
```

Same protocol, same domain, and **no trailing slash**.

Once you are in:

1. **Admin → Station → Sub/Wave Server** → **Test**. This checks the application
   can reach your station. If this fails, nothing else will work, so fix it
   first.
2. **Admin → People** → approve yourself if for any reason you are not already
   admin, and this is where you approve listeners from now on.
3. **Admin → Station → Identity** → set your name, description and logo. This
   rebuilds the application, so do it when nobody is listening.

---

## Moving to Postgres

**You do not have to do this.** SQLite is a single file, it handles a station of
this size comfortably, and backing it up is copying one file. Most stations
should stay on it. Consider Postgres if you want the database on a different
machine from the application, if you would rather not lose data when you replace
a disk, or if you expect to grow a lot.

### What Postgres is

A separate database server. It runs as its own program, on its own machine or as
a service you pay a small monthly fee for. It handles far more traffic and far
more data than SQLite, and it is what you would reach for if this were a
commercial application rather than a station.

### Getting one

Either install it on your server (`apt install postgresql`), or sign up with a
managed provider. Managed is easier and cheaper at small sizes; self-hosting
gives you the data on your own disk.

Create a database and a user for it. Three things to get right:

**Use a direct address, not a pooled one.** Managed providers put a *connection
pooler* in front of Postgres, which shares a small number of connections across
everyone using the database. That is good for running a station and bad for
administration: a pooler will only authenticate the user account it created for
you, so any *other* user you create — including the application user — cannot
log in through it. Managed providers show you a "direct" or "session" port
alongside the pooled one. Use the direct one here.

**Your user may not be allowed to log in yet.** If you copied a role from a
standard template it may be set to `NOLOGIN`, which means it cannot connect at
all until you turn that on.

**Run the permission commands against the right database.** The commands below
act on a *schema*, and a schema belongs to one database. Run them connected to
your station's database. If you run them against the wrong one they succeed
quietly, doing nothing useful, and you get a station that is still broken with
no error to explain it.

### The commands

Run these as a Postgres administrator, connected to your station's database,
substituting your own role and database names:

```sql
-- Let the role log in at all.
ALTER ROLE my_station_app LOGIN;

-- Let it open a connection to the database.
GRANT CONNECT ON DATABASE my_station TO my_station_app;

-- Let it create tables in the public schema.
GRANT USAGE, CREATE ON SCHEMA public TO my_station_app;

-- Make it the owner of the schema, so that later changes to its own tables work.
ALTER SCHEMA public OWNER TO my_station_app;
```

That last line is the one people leave out. Owning the schema means the role owns
every table it creates, so it can alter or drop them later. Granting permissions
on tables instead is **not** enough, because a permission grant never includes
the right to change or delete the table's shape — and the dashboard needs that
right when it moves your data.

### Point the application at it

```
DB_PROVIDER="postgresql"
DATABASE_URL="postgresql://my_station_app:YOUR_PASSWORD@YOUR_HOST:5432/my_station?schema=public"
```

Put the **direct** host and port in, not the pooled one.

### Move the data

Now go to **Admin → Database** and press **Move to Postgres**.

<p align="center">
  <img src="images/admin-database.jpg" alt="The admin dashboard's Database tab: current engine, row counts, keep-alive controls, and the two move buttons" width="820">
</p>

One button does the whole job. It:

1. **Checks nobody is listening**, and refuses if somebody is, naming them. The
   move restarts the application, which would cut them off mid-song.
2. **Checks the target is usable** — that your role can actually log in and
   create tables — before copying anything.
3. **Refuses a target that already has data in it**, because mixing a copy into
   a database that already has rows leaves records pointing at things that are
   not there.
4. **Copies every table**, in batches.
5. **Proves the two match**, table by table, by comparing contents rather than
   just row counts.
6. **Switches over and restarts**, then reports which database it actually came
   back on — because the old process keeps answering for a moment while it dies,
   and "it said yes" is not the same as "it worked".

If any step fails it stops there, and your station keeps running on the database
it was already using. Fix the cause and press the button again.

**Going back to SQLite works the same way** — the same button, the other
direction. It never overwrites your existing database: a move back writes a *new*
file, checks it, and only then puts it in place.

### A note on migrations

The migration files in this project are written for **SQLite only**. They use
`DATETIME`, which Postgres does not have — it wants `TIMESTAMP`. So Postgres is
built from the schema definition directly instead of from the migration history.

This is deliberate and it is not two schemas to keep in sync. There is one
canonical schema file; a small script rewrites only the part that names the
database engine, and both engines are built from that one file.

The practical consequence: `npx prisma migrate deploy` is for SQLite. Do not run
it against Postgres.

### If your Postgres suspends when idle

Free-tier database services often suspend after a period with no traffic, and the
next listener waits several seconds while it wakes. **Admin → Database** has a
switch that sends one cheap empty query on a timer to prevent that. It writes
nothing and costs nothing. Leave it on, at the default 300 seconds.

---

## Branding

Two ways to do it, and the dashboard is easier.

**From the dashboard.** Go to **Admin → Station → Identity**. Set the name,
tagline, description, sign-in text and logo. The logo you upload is also used to
regenerate the app icon, the icon phones use, and the favicon. Saving rebuilds
the application so the new values reach people's browsers, and restarts only if
the build succeeded — a failed build leaves the working version alone rather than
taking your station offline.

**By hand.** Edit the `NEXT_PUBLIC_STATION_*` lines, and put your artwork in
`data/brand/`:

| File | Used for | Good size |
|---|---|---|
| `data/brand/logo.png` | header and sign-in screen | wide, about 5:1 |
| `data/brand/bg.jpg` | the background behind everything | large, dark or low-contrast |
| `data/brand/icons/` | the app icon on phones | square, 512×512 or larger |
| `data/brand/favicon.ico` | the browser tab icon | square, 512×512 or larger |

**Why `data/brand/` and not `public/`.** The repository ships placeholder artwork
in `public/defaults/`, and a deploy replaces it. `data/brand/` holds your
station's own artwork and is excluded from both the repository and the deploy, so
a deploy can never overwrite it. The site asks for `/brand/logo.png` and similar
regardless of what is in there: your file if you have one, the placeholder if you
do not. So one URL serves either, uploads apply the moment they finish with no
rebuild, and deleting a file from `data/brand/` puts the placeholder back.

The two can be mixed. Upload a logo and leave the background as the placeholder,
and each is served independently.

**Why the background should be dark or busy-but-dark:** text sits directly on
top of it with no panel behind it, so a bright sky makes some of the text
genuinely unreadable.

---

## Backups

Back up **two** things, and keep them in **two different places**.

**1. Your configuration file.** It contains `PII_ENCRYPTION_KEY`. A restored
database without that key is permanently unreadable, and a changed
`NEXTAUTH_SECRET` logs every listener out.

```bash
cp /srv/subwave-listener/.env.local ~/backups/env.local.$(date +%F)
```

**2. Your database.**

SQLite — the whole database is one file, but copy it with the application stopped
so you do not capture a half-written page:

```bash
systemctl stop subwave-listener     # or: pm2 stop subwave-listener
sqlite3 /srv/subwave-listener/data/app.db ".backup '/root/backups/station-$(date +%F).db'"
systemctl start subwave-listener    # or: pm2 start subwave-listener
```

Postgres — use its own tool, and run it on a schedule:

```bash
pg_dump "$DATABASE_URL" --format=custom --file "/root/backups/station-$(date +%F).dump"
```

**Test a restore before you need one.** A backup you have never restored is a
theory, not a backup. Once a quarter, restore into a scratch database and check
your listeners are in it.

---

## Upgrading

```bash
cd /srv/subwave-listener
git pull
set -a; . ./.env.local; set +a
npx prisma migrate deploy      # SQLite only; safe to run when already current
npm ci                          # only if dependencies changed; slow
npm run build
pm2 restart subwave-listener
```

**Read the notes before pulling.** If a release includes a change that is not
backwards-compatible with the database, that matters *before* the new code
starts, not after.

**Rolling back** is building the previous version again, as long as no
incompatible migration ran:

```bash
git log --oneline -5
git checkout <the-sha-you-were-on>
set -a; . ./.env.local; set +a
npm run build
pm2 restart subwave-listener
```

If a migration did run, restore the database from a backup instead. Do not reach
for `migrate reset` — it discards everything since.

---

## Checking a deploy worked

A build that failed but was deployed anyway is a common and confusing failure, so
check explicitly.

```bash
# What is there now
cat /srv/subwave-listener/.next/BUILD_ID

# Build again
npm run build

# What is there after — this must be DIFFERENT
cat /srv/subwave-listener/.next/BUILD_ID
```

If the two are the same, the build did not produce anything new and restarting
would serve the old version while you believe you deployed the new one.

Then check the application is answering:

```bash
pm2 list
curl -s -o /dev/null -w "%{http_code}\n" https://station.example.com
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" --max-time 15 "http://127.0.0.1:3000/api/stream?t=1"
```

You want `200` for the first, and `200 audio/mpeg` for the last. A `401` or
`404` on the stream is a station password problem rather than a deploy problem —
see [the troubleshooting section in docs/listener-modes.md](listener-modes.md#troubleshooting).

---

## Troubleshooting

### Sign-in does not work

**The redirect URI does not match.** Compare, character by character, the URI in
the Google Cloud Console and `NEXTAUTH_URL` plus `/api/auth/callback/google`.
This is the cause almost every time — the protocol, the domain, or a trailing
slash differing by one character.

**`NEXTAUTH_URL` is wrong.** It must be the address people actually visit,
including `https://`, with no trailing slash.

### "PII_ENCRYPTION_KEY is not set"

The application will not start without it, deliberately. Generate one and set
it — or restore the original, because a *new* key cannot read data encrypted
with the old one.

### "Environment variable not found: DATABASE_URL" from Prisma

The Prisma tool reads `.env` and `prisma/.env`, not `.env.local`. Run
`set -a; . ./.env.local; set +a` first.

### The admin dashboard is not protected

Check three things:

1. The file is named `proxy.ts`, not `middleware.ts`.
2. The function it exports is named `proxy`.
3. There is no `middleware.ts` as well.

The underlying framework renamed this convention, and **a file it does not
recognise is ignored completely silently** — no error, no warning. An ignored
security check fails *open*, which is the worst possible outcome and looks
exactly like success. Test it from outside: with no cookie, request
`https://your-station.example.com/api/presence`. You must get `401`. If you get
data, the check is not running.

### It works on your machine and 404s on the server

`NEXT_PUBLIC_*` values are compiled in at build time. A build made on your
machine ships your machine's values. Build on the server.

### Listeners are being signed out constantly

`NEXTAUTH_SECRET` is not stable, or more than one copy of the application is
running with different values. It must be set, and identical everywhere.

### The first request after a quiet period hangs for several seconds

A suspended Postgres waking up. Turn on the keep-alive in **Admin → Database**.

### No audio at all after a reboot

**Check whether the audio server is even running.** This is the failure that
looks like something else, because the page still loads, the artwork still
appears, and the track information still updates — only the sound is missing.

```bash
systemctl is-active icecast2      # want: active
ss -lntp | grep 8000              # want: a line showing icecast2 listening
```

A package install can leave the service **disabled**, which means it does not
come back after a reboot and nobody notices until the next one. Always check
both:

```bash
systemctl enable icecast2
systemctl is-enabled icecast2     # want: enabled
```

Then confirm the relay can actually reach your station, and get the password
from the app rather than typing it:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" --max-time 25 \
  "http://127.0.0.1:8000/stream.mp3?auth=$STATION_PASSWORD"
# want: 200 audio/mpeg
```

If the relay is up but that returns `401`, the password has drifted — see the
entry below. If the station host is asleep, wait for it to wake and try again.

> **Check this first whenever a listener says "no sound".** Everything on the
> page is served by the application, and everything that produces sound is served
> by a *separate* program on the same machine. One being healthy tells you
> nothing about the other.

### The relay sync fails with an authentication error

`Relay reloaded but local /stream.mp3 answers 404 — check server address/password`,
or a message about interactive authentication.

If the app runs as a service account, it needs the sudo rule from
[Step 7](#give-it-permission-to-reload-the-audio-server-and-nothing-more) to
reload the audio server. Test it directly:

```bash
su -s /bin/bash subwave-listener -c 'sudo -n /usr/bin/systemctl reload icecast2 && echo ok'
```

If that prints `ok`, the rule is fine and the problem is the password. If it
fails, re-check `/etc/sudoers.d/subwave-listener` with `visudo -cf`.

### Audio does not play but the track information updates

Almost always a station password that does not match in all three places. Full
diagnosis in [docs/listener-modes.md](listener-modes.md#troubleshooting).
