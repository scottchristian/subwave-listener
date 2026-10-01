# Stream modes and listener counting

How the music reaches a listener, why listener addresses look the way they do,
and what has to be reachable for either mode to work.

- [The two modes](#the-two-modes)
- [What each mode does to the audio path](#what-each-mode-does-to-the-audio-path)
- [Why every listener shows the same address behind a relay](#why-every-listener-shows-the-same-address-behind-a-relay)
- [Where the listener count comes from](#where-the-listener-count-comes-from)
- [Network reachability between the player and the station](#network-reachability-between-the-player-and-the-station)
- [Switching modes](#switching-modes)
- [Troubleshooting](#troubleshooting)

---

## The two modes

Set in **Admin → Station → Stream Mode**. The default is **relay**.

|  | **Relay** (default) | **Direct** |
|---|---|---|
| Who connects to the station | one relay connection | every listener, one each |
| Upload your station uses | the same, always | grows with the audience |
| Count your station reports | number of relay connections | exact, per listener |
| Where the station password lives | on the server | in the page, visible to listeners |
| Needs a relay running | yes | no (it stays as a fallback) |

**Relay is the default for a reason.** Most stations run on a home connection
with modest upload, and the point of the relay is that the station sends its
audio out **once**, however many people are listening. Direct mode gives your
station an exact listener count and per-listener addresses for free — but the
upload grows with the audience, and for a popular station that is the difference
between a home connection coping and not.

Choose direct mode if your audience is small and known, or if you specifically
need your station's own dashboard to show true per-listener data.

### The station password in direct mode

Direct mode puts the station password into the page your listeners download, so
any approved listener can read it by viewing the page source.

They are approved, so this is a considered trade rather than a mistake — but it
does mean the password is **shared** rather than **held**, and should be treated
that way. If your listener list ever stops being entirely trustworthy, change the
password. Relay mode keeps it on the server, and that is the main reason to
prefer it.

---

## What each mode does to the audio path

**Relay mode** — the default. One connection upstream, fanned out locally:

```
listener's browser
  → your public address              (the encrypted connection ends here)
  → this application, /api/stream    (adds the password for the relay)
  → Icecast relay, on the same server (one connection to your station)
  → your station
```

**Direct mode** — the relay is not in the path at all:

```
listener's browser
  → your public address
  → your station's own stream address, with the password attached
```

Either way, two settings decide where the last hop goes: `SUBWAVE_API_URL` and
`SUBWAVE_STREAM_URL`. The application does not care whether those addresses are
IPv4 or IPv6 — see
[reachability](#network-reachability-between-the-player-and-the-station).

---

## Why every listener shows the same address behind a relay

Worth knowing before you go looking for a fault.

The audio server software, Icecast, reports **the address of whoever opened the
connection**. Behind a relay, whoever opened the connection *is the relay* — so
every listener is reported as the relay's own address, and they all look
identical.

This is a property of the software, not a misconfiguration, and no setting
changes it. There is a setting that looks like it might, called
`x-forwarded-for`, and in the standard build it does nothing.

Two consequences:

1. **Your station cannot tell your listeners apart in relay mode.** It sees one
   connection, not one per person. That is also why it needs the relay's
   connection count rather than its own list to report a sensible audience.
2. **This application does not store listener addresses either.** Because
   listeners sign in, it knows *which account* is listening — **Admin → People**
   shows that, with time listened and likes. But no address is recorded against
   a session. If you need per-listener addresses, direct mode is the only way to
   get them, and they come from your station, not from here.

---

## Where the listener count comes from

Two counts exist, and they will not always agree. That is not a bug.

**This application's count.** Every time somebody presses Play, a listening
session starts; when they disconnect, it closes. Sessions are then bundled, so a
connection that drops and reconnects — over a redeploy, or a brief network
problem — reads as one listen rather than several. Sessions older than ten
minutes are ignored, so a row left behind by a hard kill eventually stops
counting. **Admin → People** uses this, and so does the check that stops a
database move while people are listening.

**Your station's count.** Whatever your station is configured to read. Left
alone it looks at the connections on its *own* audio server, which in relay mode
is empty or a single self-connection — so the number looks wrong. Point it at
**the relay's admin page** instead, and it will report the relay's connection
count, which is the real audience.

The relay's admin page is a small web page listing who is connected. It is
protected by a password, and that password has to match what your station is
configured to use. The setting lives in your station's own configuration — look
for an `ICECAST_`-prefixed variable in the station host's documentation for the
current name.

**The two differ by design.** This application counts *accounts currently
streaming*; your station counts *connections*. One person on a phone and a laptop
is one row here and two connections there.

---

## Network reachability between the player and the station

### What has to be true

One thing: **the machine running the player must be able to open a connection
out to the machine running the station.**

That is the entire requirement. The player dials out; nothing has to dial in.

And it makes no difference whether that connection uses IPv4 or IPv6. The
software does not care which version of the protocol it ends up using, and both
`SUBWAVE_API_URL` and `SUBWAVE_STREAM_URL` accept either. There is no IPv6
requirement anywhere in this software, and no IPv4 requirement either. Put in
whichever address your station is reachable on.

### Check before you do anything

Most people reading this section do not need it. Find out before you set
anything up.

On the machine that will run the player, try to open your station's address:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://radio.example.com/api/now-playing
```

You want `200`. If you get `200`, the two machines can already see each other and
you can skip the rest of this section.

**Admin → Station → Sub/Wave Server → Test** does the same check, and tells you
what went wrong if it fails.

### If your station is at home

Now the common case.

Most stations run on a home internet connection, and most home connections sit
behind **CGNAT** — short for carrier-grade NAT. In practice this means your
router does not have a public address of its own: your internet provider shares
one public address between many customers, and translates yours to a private one
at their end. Many home connections are like this, including a large share of
mobile providers and some fixed-line ones.

It is not a fault, and no setting inside your house changes it.

**A port forward** is the ordinary way to make something on your home network
reachable from the internet: you tell your router to pass incoming connections
on a given port through to a particular machine inside the network. It works when
you have an address to forward *to* — and with CGNAT, you do not. That is the
whole problem.

So, in rough order of how many people use them:

#### Option 1 — the player on a VPS, and an IPv6 port forward to the station

The most common arrangement, and the one this application is built around.

The player goes on a small VPS, where it gets a public address and a certificate
easily. The station stays at home. For the VPS to reach the station, the station
needs a way in.

**Most providers do give you a real IPv6 address, even when the IPv4 is shared.**
It is genuinely yours, it is not shared, and you can forward it. So: in your
router's settings, forward a port to the machine running your station, then put
your station's IPv6 address into `SUBWAVE_API_URL` and `SUBWAVE_STREAM_URL`.

**Where IPv6 is not available to you**, use one of the other two options instead.
Some providers do not offer it at all, and some routers will not pass it through
until you change a setting.

#### Option 2 — a private network overlay, such as Tailscale

**What it is.** Software that links your own devices together across the internet
as though they were plugged into the same router at home. Each device gets a
private address that nothing outside your group can reach, and traffic between
them is encrypted. Tailscale is the best-known; anything built on WireGuard does
the same job.

**Why you might want it.** Two reasons, both about not leaving doors open:

- It solves the CGNAT problem above completely, because no incoming connection
  is ever needed. Your devices call out and the overlay handles the rest.
- Your relay has an **admin page** — a web page listing how many listeners are
  connected, behind a password. Your station must be able to read it to report a
  correct count. You may not want that page reachable from the whole internet,
  and an overlay keeps it private without you writing firewall rules by hand.

**What it costs.** Nothing, for a small number of machines. Install it on the two
machines that need to see each other and sign them into the same account.

**This is optional.** If your machines can already reach each other, you do not
need it. It is a convenient way to avoid opening ports, not a requirement.

#### Option 3 — a port forward on a real IPv4

Some connections are not behind CGNAT and do have a public IPv4 address of their
own. If yours is one, a port forward is the simplest option and needs nothing
else installed.

Two precautions. **Restrict who can connect** using your firewall, so only the
player's address can reach the port rather than the whole internet. And remember
the relay's admin page is behind a password — that is real protection, but not a
substitute for restricting access, so getting it wrong here is a genuine
exposure rather than a cosmetic one.

### After you pick an option

- **`SUBWAVE_STREAM_URL` must be your relay, never your station.** Pointing it
  at the station makes every listener open their own connection back to the
  station, which is the exact thing the relay exists to prevent.
- **Your station must be able to reach the relay's admin page** for its count to
  be right. If the relay only listens on `127.0.0.1` — that is, only inside the
  player server — your station cannot reach it from another machine. Either bind
  the relay to your overlay address, or permit your station's address in the
  firewall.
- **Do not leave the relay's admin port open to the whole internet** if you have
  an overlay available to you.

---

## Switching modes

**Admin → Station → Stream Mode**, then save. The change applies the next time
somebody presses Play — anyone already listening is left alone rather than cut
off. The card shows the current mode and warns about upload cost and password
visibility in place, rather than leaving it to this document.

To move a listener across immediately, they press Stop and then Play. Anything
already buffered is discarded.

---

## Troubleshooting

**The player is stuck on "Starting station…", the browser console shows
`404 /api/stream`, but the artwork and track title keep updating.**

Audio only — the track information is a separate request that needs no password,
so this is almost always a password that does not match. Three places hold it and
all three must agree:

1. **Admin → Sub/Wave Server → Station Password** in this application
2. The master password in your relay's configuration
3. The listener password in your station's own settings

Compare them by hash rather than by eye — a password that differs by one
character looks identical when you are reading it. And never paste a real one into
a chat or an issue; show its shape with the value replaced.

After fixing it, restart the relay. A rejected connection often leaves it waiting
to retry rather than retrying cleanly, and real players reconnect on their own.

**No audio at all, and no track information either.**

The player cannot reach your station. Check that `SUBWAVE_API_URL` is an address
the server can open — and remember it must be **public**, not a home network
address, because listeners' browsers fetch some things directly and a home
network address will not resolve for them.

**Your station reports 0 listeners while people are clearly listening.**

Its count is pointed at its own audio server rather than at the relay. See
[where the count comes from](#where-the-listener-count-comes-from).

**Your station reports 1 listener forever, long after everybody left.**

A relay connection that never closed. Your station's idle detection trusts that
number, so it will never see a clean zero and will never pause when the station
is empty — which quietly costs money overnight.

Confirm it first: if your station's own connection list is non-empty while
**Admin → People** shows nobody streaming, that is the signature. Restarting the
relay drops the stale connection, and real players reconnect by themselves.
