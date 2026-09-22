# Who your server trusts

Three ways a home server quietly believes the wrong thing — and the small settings
that fix each one. No security background needed.

crate is the worked example here, but none of these are specific to it. They turn up
in most things you can run at home, and the settings that fix them usually exist
already, waiting to be filled in.

---

## The one idea

Nearly every security setting on a home server answers the same question: **whose word
do you take for it?**

Your server is constantly being told things. "I'm connecting from this address."
"Here's my password." Some of that can be checked. Some of it is just a claim, typed by
whoever is knocking.

Trouble starts when a server treats a claim as a fact. It doesn't look like a break-in
when it happens — everything keeps working normally, which is exactly why these three
go unnoticed for years.

---

## Trap one — anyone can claim to be someone else

> **Put plainly.** It's the return address on an envelope. You can write whatever you
> like there, and the postman won't stop you. The only thing that can't be faked is
> which letterbox it was actually posted into.

When something connects to your server, there are two versions of "where it came from":

- **The connection itself.** Your server sees this directly. It can't be faked — it's
  how the reply gets back.
- **A line in the request saying "the real visitor is…".** This is just text the sender
  typed. It exists for a good reason: if you run a reverse proxy, your app would
  otherwise think every visitor in the world is your proxy. So the proxy adds a note
  saying who it really was.

The catch is that a note like that is only worth anything when a proxy you actually run
wrote it. If your app believes that line from *anyone*, then anyone can write it.

```text
  ┌─────────────────┐   claims  ┌─────────────────┐    adds   ┌─────────────────┐
  │     Visitor     │ ────────► │    Your proxy   │ ────────► │     Your app    │
  │ could be anyone │           │   you run this  │           │  has to choose  │
  └─────────────────┘           └─────────────────┘           └─────────────────┘

                   "I'm 10.0.0.9"            "actually 203.0.113.9"
                just typed by whoever         attested by a machine
                     is knocking                   you control
```

Both notes look identical to your app. The difference is entirely who handed it over.

This matters more than it sounds, because that address is usually what a server counts
*against* you. Most apps slow down repeated wrong passwords — say six tries, then a
pause. To do that, they have to group the attempts somehow, and they group them by
address.

**So the limit stops working.** If the address can be chosen by the person guessing,
every guess can arrive under a fresh one. Six tries becomes unlimited tries, and nothing
in the app looks broken — the limit is still right there in the settings.

### What to do

Tell your app which machines are allowed to speak for others — and that's only ever your
own proxy. In crate, that's one setting. If you run it behind a reverse proxy, give it
the proxy's address or range:

```
CRATE_TRUSTED_PROXIES=172.18.0.0/16
```

If nothing is in front of crate, leave it empty. Empty is the safe setting here, not an
unfinished one — it means "believe the connection, ignore the notes".

Other apps word it differently. Look for *trusted proxies*, *trusted hosts*, or *real IP
from*, and set it to your proxy rather than leaving it wide open.

---

## Trap two — a lock on one door only

> **Put plainly.** A deadbolt on the front door, fitted properly, well reviewed — while
> the back door off the laundry doesn't lock at all. Nobody notices, because everyone
> uses the front.

Most self-hosted apps have more than one way in. There's the web page you sign into, and
then there's whatever your phone apps and scripts use. They're separate code, written at
different times, and it's common for the careful work to land on only one of them.

Music servers are a good example. Alongside the website, crate speaks the Subsonic
protocol so third-party music apps can connect. That path has a quirk: there's no
"staying signed in". **Every single request carries the username and password again** —
hundreds of times while you listen to an album.

That makes it an unusually attractive door. It expects to be hammered, and until recently
crate's own version checked each password with no limit on how often you could be wrong.

**The front door's lock was decorative.** Six-tries-then-wait on the website means very
little if the same passwords can be tried without limit somewhere else. Anyone looking
simply uses the other door.

### What to do

- **Update.** This one isn't a setting you can turn on — the fix has to be in the
  software. crate now applies the same limit to both paths.
- **Don't try to solve it with a login gateway.** Putting one in front of your whole app
  breaks music clients completely: they can't fill in a login form. If you use a gateway,
  protect the website and leave the music path to the app's own password checking.
- **When you try an app out, test the other door too.** Type a wrong password into your
  phone client several times over. If it never slows down or complains, that door has no
  lock on it.

---

## Trap three — passwords hiding in your logs

> **Put plainly.** A security camera pointed at the keypad. It's doing its job perfectly
> — and it has recorded your PIN, every time you've entered it, in something you'll
> happily email to a stranger when you need help.

Your server keeps a log: a running list of what was asked for and when. It's the first
thing you read when something misbehaves, and the first thing you paste into a forum post.

Web addresses sometimes carry more than a page name. The Subsonic protocol is one of the
places where the password travels *in the address itself*, because that's how the
protocol was designed decades ago. So the log entry for an ordinary request can contain a
working password — written in plain text, kept for months, copied wherever your logs get
copied.

Some setups use a token instead of the password, which sounds safer but isn't much: the
token can be replayed exactly as it stands for as long as that password does.

**It spreads quietly.** Logs get backed up, shipped to dashboards, and pasted into help
threads. A password in a log has been copied to more places than you'd guess, by people
trying to be helpful.

### What to do

- **Have a look.** Search your app's log for `password=`, `&p=` or `token=`. It takes a
  minute and the answer is usually obvious.
- **If you find any, change that password** — and treat the old one as known, not private.
- **Redact before you share.** Logs pasted into a forum or an issue are public forever.
  Skim them first.
- **Use a separate streaming password** where the app offers one, as crate does. Then the
  one that travels in addresses isn't the one guarding your account.

crate now masks these before writing anything down: the entry still shows which request it
was, with the secret replaced by `[redacted]`.

---

## Before you open it up

A short list worth running through before anything of yours is reachable from outside the
house.

- [ ] **Don't publish it straight to the internet.** Put a reverse proxy in front. Most
      self-hosted apps expect one and are built assuming it's there.
- [ ] **Turn on HTTPS.** Without it, passwords cross the network readable. A proxy will
      handle the certificate for you, usually free and automatically.
- [ ] **Tell the app which proxy to trust.** Trap one. Skip this and either the limits
      don't work, or everyone shares one bucket and a stranger's wrong guesses lock you out.
- [ ] **Change every default password.** Including the one the install guide told you to
      set. Anything shipped as `admin` / `change-me` is tried first, within minutes of you
      going live.
- [ ] **Try the wrong password on purpose.** On the website and in a phone client. If
      neither ever slows you down, you've found trap two.
- [ ] **Read your own log once.** Just once, properly. You're checking whether anything
      secret is being written down.
- [ ] **Decide how you'll hear about updates.** Security fixes only help once installed. A
      note in your calendar counts; nothing at all doesn't.

None of this needs a security background. It's mostly asking, for each thing your server
believes, whether it has any way of checking.

---

## Words you'll run into

**Reverse proxy** — A small piece of software that sits in front of your apps and passes
requests through. It's the receptionist: everything arrives at one desk, gets directed to
the right room, and gets its HTTPS certificate handled on the way. Nginx, Caddy and
Traefik are the common ones.

**Header** — Extra notes attached to a web request that you never see: what browser is
asking, what language you prefer, and the "the real visitor is…" line from trap one.
Handy, but written by whoever sent the request.

**Brute force** — Guessing passwords by trying enormous numbers of them, automatically.
Not clever, just patient, and entirely done by software. It's why "how often can someone
be wrong?" matters more than password complexity alone.

**CIDR, as in `172.18.0.0/16`** — Shorthand for a range of addresses rather than a single
one. The number after the slash says how much is fixed: a bigger number is a narrower
range. You'll meet it wherever a setting wants "which machines", and you can usually copy
the value straight out of your proxy's own configuration.

**Rate limit / lockout** — A cap on how often something can be attempted: six wrong
passwords in fifteen minutes, then a pause. It doesn't make a password stronger; it makes
guessing one slow enough not to be worth it.

**Redaction** — Deliberately blanking something out before it's written down or shared. A
good log redacts the secret and keeps everything else, so it's still useful for working
out what went wrong.
