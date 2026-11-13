<!-- Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr), AGPL-3.0-only; see LICENSE and NOTICE.
     Modified by samschultzponsys, 2026-11-13: rewritten for DreyMail (credits, quick start, releasing); upstream docs kept and rebranded.
     Modified by samschultzponsys, 2026-11-13: v1.1 status (icon, cyan accent).
     Modified by samschultzponsys, 2026-11-13: v1.2 (account colours, All inboxes switch).
     Modified by samschultzponsys, 2026-11-13: v1.3 (signatures, settings tabs).
     Modified by samschultzponsys, 2026-11-13: v1.4 (administration, sign-in settings).
     Modified by samschultzponsys, 2026-11-13: v1.5 (DreyMail's own names; upgrade notes).
     Modified by samschultzponsys, 2026-11-13: v1.6 (UI clean-up).
     Modified by samschultzponsys, 2026-11-13: v1.7 (desktop apps).
     Modified by samschultzponsys, 2026-11-13: v1.8 (Android app).
     Modified by samschultzponsys, 2026-11-13: v1.9 (Android app attached).
     Modified by samschultzponsys, 2026-11-13: v2.0 (tablets/foldables, interface size, your name, Android updates).
     Modified by samschultzponsys, 2026-11-13: v2.1 (version, update dot, changelog). -->
<p align="center"><img src="branding/dreymail-icon.svg" alt="DreyMail icon" width="128" height="128"></p>

# DreyMail

*Pronounced "DRAY-mail". A drey is a squirrel's nest.*

A self-hosted webmail portal for my own Gmail and Purelymail accounts (or any IMAP/SMTP
account), for desktop browsers and Android.

## Credits / Origin

DreyMail is based on **[Ratatoskr](https://github.com/magnuspihl/Ratatoskr)** by **Magnus Pihl**
and contributors, licensed under the GNU AGPL v3.0. It started from upstream commit
[`e2abaa4`](https://github.com/magnuspihl/Ratatoskr/commit/e2abaa4c585a2e0edc8a09b082208941c32afcdc)
(2026-10-27). The full upstream history is kept in this repository. Nearly all of the code and
documentation below is Magnus's work. DreyMail's changes are listed in [`CHANGES.md`](CHANGES.md).

DreyMail is an independent project. It is **not affiliated with or endorsed by** the original
author. DreyMail stays under the same license, AGPL-3.0-only; see [License](#license) and
[`NOTICE`](NOTICE).

## Status

Current version: **2.1**. Upstream's feature set with DreyMail's own look (a cyan envelope in an
indigo drey), per-account colours that recolour the whole app, an on/off switch for "All
inboxes", signatures per account or shared, administration (users, OIDC sign-in) in the app, and desktop
apps for Linux (flatpak, deb, rpm) and Windows, and an Android app with instant, end-to-end
encrypted notifications that sound and look different per account. What's planned is in
[`ROADMAP.md`](ROADMAP.md). This README is updated with every change.

## What it does

A simple, good-looking, self-hosted webmail client for **any IMAP/SMTP account**.

- **Your mail server stays the source of truth.** DreyMail keeps users, their encrypted account
  settings and preferences (plus, for notifications, push subscriptions and the newest INBOX UID
  already notified about, and for snoozed mail, folder, UID and wake-up time) in one SQLite file.
  To be quick, it also keeps an encrypted, disposable copy of each account's newest INBOX and Sent
  mail in a second one; see [Mail cache](#mail-cache).
- **One container.** Configured by environment variables, with a volume for the SQLite files. No
  Redis, no Postgres, no sidecars.
- **Modern UI.** Clean three-pane layout, first-class dark mode, usable on a phone.
- **Every email is treated as hostile.** See [Security model](#security-model).

## Features

- Several IMAP/SMTP accounts per user (host, port, TLS/STARTTLS, credentials, separate SMTP
  settings, display name, colour). Connections are tested when you save. Passwords are encrypted
  at rest (AES-256-GCM) and never sent back to the browser.
- Login with a username and password, with any OpenID Connect provider (Authentik, Keycloak, …),
  or both side by side; see [Login](#login). Each user owns their own accounts, with strict
  per-user isolation.
- **Administration in the app.** The first user is the administrator (more can be added, or
  named in `DREYMAIL_ADMIN_USERS`). Settings → Users lists everyone and adds, promotes, resets
  passwords for and removes users. Settings → Sign-in sets up OIDC (with a connection test),
  password login and who may register, without a restart. Any of these given as environment
  variables in the compose file win and show as locked in the UI.
- **Accounts that feel separate.** Each account has its own colour: the first one gets DreyMail
  cyan, and you can pick from presets or any colour on the colour wheel. While an account is open,
  the whole app takes on its colour (buttons, highlights, unread dots, a light tint on the page),
  so you always know which mailbox you're in. Button labels and accent text automatically stay
  readable for any colour, in light and dark mode.
- Unified "All inboxes" view across all accounts (merged by date, paginated with per-account
  cursors). It can be turned off in Settings to keep accounts completely apart; DreyMail then
  opens on your first account. Per-account folder trees with unread counts. Live updates via IMAP
  IDLE pushed over one WebSocket per browser session.
- Message list with sender, subject, snippet, date, unread/flagged/answered/attachment
  indicators, and an account colour tag in the unified view.
- Conversations, Gmail-style: a message and its replies are one row ("Ada, me 3") and are read
  together, older messages folded. Your replies are found in the Sent folder, also when you
  sent them from another mail client. Messages belong together when they share Message-IDs
  (References / In-Reply-To) and their subjects match apart from "Re:" and the like. Actions on
  a conversation apply to all its messages in the folder; the copies in Sent are left alone.
- Reading plain text and HTML, with inline (`cid:`) images and attachment downloads. Remote
  images are blocked by default; "Load images" has the server fetch them and embed them in the
  message, so the sender never sees your IP address. "Always load from example.com" adds the
  sender's domain (and its subdomains) to a per-user list whose mail loads images automatically;
  manage the list in Settings.
- Contact pictures instead of initials, from Gravatar, Libravatar (including a domain's own
  federated server) or, for senders at a company rather than a free mail provider, the icon of
  their website. Like remote images, the server fetches them, so these services never see your
  IP address or when you read a message. Turn them off in Settings.
- Mark read/unread, flag, move, archive, delete (to Trash, expunge only from Trash), multi-select.
  On touch screens, swipe a message left or right to delete, archive, mark read/unread or flag it
  (which action each direction does is set in Settings).
- "Unread only" filter for the current view. Messages you read there stay on screen until you
  change the view or refresh, so the list doesn't jump under your finger.
- Snooze: hide a message until a date and time you pick (or Later today / Tomorrow / This weekend /
  Next week). See [Snooze](#snooze).
- **Signatures**, in Settings → Signatures: rich text (bold, italic, links), each with checkboxes
  for the accounts that use it. Tick one account for a per-inbox signature, or several to share
  one. Optionally also added to replies and forwards. The composer puts it in below where you
  type (above any quoted message), swaps it when you change the From account, and takes on the
  From account's colour.
- Compose, reply, reply-all, and forward (with the original attachments). Includes a light
  rich-text editor, an automatic plain-text alternative, attachments, drafts (saved to the
  account's Drafts folder), a copy in Sent, and recipient autocomplete from recently used
  addresses. Special-use folders (`\Sent`, `\Drafts`, `\Trash`, `\Archive`, `\Junk`) are detected
  with name fallbacks.
- `mailto:` links open a new message in DreyMail: in plain-text mail directly, in HTML mail in a
  new tab (clicks inside the sandboxed message frame can't be caught). Settings → "Open email links
  with DreyMail" makes the browser send `mailto:` links on any website here too; the installed app
  (PWA) registers for them on its own where the browser supports it. Only recipients, subject and
  a plain-text body are taken from a link, and nothing is sent until you press Send.
- Server-side IMAP search in the current folder, or across all inboxes in the unified view.
- Dark mode that follows the system, with a manual override. Simple HTML and plain-text mail get
  dark styling. Heavily designed mail (newsletters) is shown on a light "paper" card instead of
  being force-inverted, with a per-message toggle.
- Notifications for new mail on phones and desktops (Web Push), and an unread badge on the app
  icon. Install DreyMail as an app (PWA) from the browser; see [Notifications](#notifications).
- On phones, a floating Compose button sits on the message list. Compose writes from the account
  you're in (the first account in "All inboxes"); the From menu switches it.
- **Phones, tablets and foldables.** Phones show one pane at a time. Tablets and unfolded
  foldables show the message list on the left and the open message on the right, with the
  folders in a slide-in drawer. Desktops show all three columns.
- **Interface size** per device (Settings → General): Automatic is larger in the Android app and
  follows the phone's font size; or pick 90–150%.
- **Your name** (Settings → General) is shown at the bottom left (first name only unless you tick
  "Show my full name"); typed in lower case it is capitalised for you.
- **Version and what's new.** The server's version sits next to your name; click it for the
  changelog. When a newer image is released, administrators see a blinking dot on it and the
  changelog says how to update (redeploy the stack in Arcane). The server checks GitHub at most
  every 6 hours; `DREYMAIL_UPDATE_CHECK=false` turns that off.
- Keyboard shortcuts: `j`/`k` to move, `r` reply, `a` reply all, `f` forward, `e` archive,
  `b` snooze, `#` delete, `s` flag, `u` mark unread, `c` compose, `Ctrl/Cmd+Enter` to send.

## Quick start (Docker Compose)

DreyMail is configured with environment variables written inline in the compose file (no `.env`
file). This example is how I run it: an Arcane-managed stack on Unraid, a bind mount, `PUID`/`PGID`
`99:100`, no published ports, and an external network shared with the reverse proxy.

```yaml
services:
  dreymail:
    image: ghcr.io/samschultzponsys/dreymail:latest
    container_name: dreymail
    restart: unless-stopped
    environment:
      - PUID=99
      - PGID=100
      - DREYMAIL_BASE_URL=https://mail.example.com
      - DREYMAIL_SECRET_KEY=replace-with-a-long-random-string-of-at-least-32-chars
      - DREYMAIL_TRUST_PROXY=true
      - OIDC_ISSUER_URL=https://auth.example.com/application/o/dreymail/
      - OIDC_CLIENT_ID=dreymail
      - OIDC_CLIENT_SECRET=replace-with-the-client-secret
    networks:
      - customnetex
    volumes:
      - /mnt/nvme2tbadata/dockerstatic/dreymail:/data

networks:
  customnetex:
    external: true
```

1. Register an OIDC client at your identity provider (see [OIDC setup](#oidc-setup)), or drop the
   `OIDC_*` lines to use username/password login.
2. Generate the secret key with `openssl rand -base64 48` and set `DREYMAIL_BASE_URL`.
3. Point your reverse proxy at `dreymail:8080`, open `https://mail.example.com`, sign in, and add
   your first mail account.

The variables still use the upstream `DREYMAIL_*` names so existing deployments keep working.
Renaming them, with the old names still accepted, is on the [roadmap](ROADMAP.md). So is a
settings page for all configuration (OIDC and the rest), with compose environment values
overriding what's set there.

Images are published to `ghcr.io/samschultzponsys/dreymail` for every release (see
[Releasing](#releasing)), tagged with the version (`1.0`, `1.1`, …) and `latest`. You can also
build it yourself with `docker build -t dreymail .`.

The server runs as user and group `1000:1000` unless `PUID`/`PGID` say otherwise, and takes over
the data directory on start (it `chown`s it when anything in it belongs to someone else). `UMASK`
(e.g. `002`) sets the permissions of the files it creates. Starting the container with `--user`
(`user:` in Compose) also works; then it runs as that user, ignores `PUID`/`PGID` and changes no
ownership.

## Desktop apps (Linux and Windows)

Every release has desktop apps attached, with the version in the file name:

| File | For | Install |
| --- | --- | --- |
| `DreyMail-1.7-x86_64.flatpak` | any Linux with Flatpak | `flatpak install --user ./DreyMail-1.7-x86_64.flatpak` |
| `DreyMail-1.7-amd64.deb` | Debian, Ubuntu, Mint | `sudo apt install ./DreyMail-1.7-amd64.deb` |
| `DreyMail-1.7-x86_64.rpm` | Fedora, openSUSE | `sudo dnf install ./DreyMail-1.7-x86_64.rpm` |
| `DreyMail-Setup-1.7-x64.exe` | Windows 10/11 | run it (it isn't code-signed yet, so Windows SmartScreen asks: *More info → Run anyway*) |

The app asks for your DreyMail server's address once (change it later under *DreyMail → Change
server…*) and then shows DreyMail in its own window:

- **Notifications in each account's colour.** New mail pops up as a native notification whose
  icon is the envelope in that account's colour, so you see at a glance which inbox it's for.
  Click it to open the message. Closing the window keeps DreyMail running in the tray, so
  notifications keep coming; *Quit* from the tray or menu stops it.
- **Updates.** The app checks for a newer release every time it starts, and on demand (*DreyMail →
  Check for updates…*, the tray menu, or Settings → General). It knows how it was installed and
  shows the exact upgrade for that: the flatpak, apt or dnf command (copied to your clipboard,
  with the download opened), or on Windows it downloads the new installer and runs it.
- Links in mail open in your normal browser; the window only shows your DreyMail server and its
  sign-in. *Help → Source code* links to this repository.

## Android app

Every release also has `DreyMail-X.Y.apk`. Download it on your phone and open it (allow your
browser to install apps when Android asks). It asks for your DreyMail server's address once.

- **Instant, per-account notifications.** Your server already watches every inbox with IMAP IDLE;
  the moment mail lands it wakes the phone through Firebase Cloud Messaging, the same way Spark
  and Gmail do. No polling, no permanent "checking mail" notification, no mail passwords on the
  phone.
- **Each account sounds and looks different.** Every account is its own Android notification
  channel: Settings → Notifications in the app lists them, and each one opens Android's own
  sound/vibration/importance settings. The status-bar icon is tinted in the account's colour and
  the notification shows the envelope in that colour. Notifications of the same account are
  grouped, tapping one opens the message, and they disappear when the mail is read elsewhere.
- **Private.** Notifications are end-to-end encrypted to the phone (Web Push encryption,
  RFC 8291): Google relays only ciphertext.
- **Updates built in.** The app checks for a newer release when it starts, when you come back to it
  after a few hours, and from Settings → General. "Update now" downloads it inside the app (with a
  progress notification) and opens Android's install screen; the first time, Android asks you to
  allow DreyMail to install updates. Your login and settings stay.

**One-time setup** (administrator): create a free Firebase project and enter its values in
Settings → Android. The page walks you through it (about 10 minutes). Or set them in the
compose file instead, which then wins over the UI:
`DREYMAIL_FIREBASE_SERVICE_ACCOUNT` (the service account JSON, one line),
`DREYMAIL_FIREBASE_API_KEY`, `DREYMAIL_FIREBASE_APP_ID`, `DREYMAIL_FIREBASE_SENDER_ID`.

## Upgrading to 1.5 (new names)

DreyMail 1.5 uses its own names throughout. In your compose file, rename every environment variable
that starts with the old upstream prefix to start with `DREYMAIL_` instead (same suffix, e.g. the
secret key becomes `DREYMAIL_SECRET_KEY`). DreyMail refuses to start with the old names and lists
each one with its new name, so nothing is silently ignored. On first start it upgrades your data
volume by itself:

- the database file is renamed to `dreymail.db`;
- stored mail passwords (and an OIDC client secret set in the UI) are re-encrypted with DreyMail's
  own keys, from the same `DREYMAIL_SECRET_KEY` value;
- the mail cache is rebuilt (it refills in the background);
- everyone signs in once more, and each device's notifications re-register by themselves the next
  time DreyMail is opened on it.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DREYMAIL_BASE_URL` | yes (prod) | `http://localhost:8080` | Public URL of the app. Used for the OIDC redirect URI, cookie `Secure` flag and WebSocket origin check. |
| `DREYMAIL_SECRET_KEY` | yes | – | Master secret, at least 32 characters (`openssl rand -base64 48`). Subkeys for credential encryption, session cookies and URL signing are derived from it with HKDF. **If you change it, stored account passwords can no longer be decrypted.** |
| `DREYMAIL_PASSWORD_LOGIN` | no | `true` without OIDC, `false` with OIDC | Username/password login. |
| `DREYMAIL_REGISTRATION` | no | `first` | Who may create a password account: `open` (anyone), `first` (only the first user of an empty instance) or `closed`. |
| `OIDC_ISSUER_URL` | for OIDC | – | Issuer URL; `/.well-known/openid-configuration` is discovered from it. |
| `OIDC_CLIENT_ID` | for OIDC | – | Client ID. |
| `OIDC_CLIENT_SECRET` | usually | – | Client secret (confidential client). |
| `OIDC_SCOPES` | no | `openid email profile` | Requested scopes. |
| `OIDC_LABEL` | no | `Single sign-on` | Provider name on the login button ("Sign in with …"), e.g. `Authentik`. |
| `DREYMAIL_TRUST_PROXY` | no | `false` | Trust `X-Forwarded-*` headers. Set to `true` behind a reverse proxy. |
| `DREYMAIL_DATA_DIR` | no | `./data` (`/data` in the image) | Where `dreymail.db` and the mail cache `cache.db` (SQLite) live. |
| `PUID` / `PGID` | no | `1000` / `1000` | Docker image only: user and group the server runs as and that owns the data directory. |
| `UMASK` | no | – | Docker image only: umask for files the server creates, e.g. `022` or `002`. |
| `PORT` / `HOST` | no | `8080` / `0.0.0.0` | Listen address. |
| `DREYMAIL_BLOCK_PRIVATE_MAIL_HOSTS` | no | `false` | Refuse IMAP/SMTP hosts that resolve to private/internal addresses. Turn on if untrusted users can log in. Leave off if your mail server is on your LAN. |
| `DREYMAIL_IMAP_IDLE_TIMEOUT` | no | `300` | Seconds before an unused pooled IMAP connection is closed. |
| `DREYMAIL_MAX_MESSAGE_MB` | no | `50` | Largest message the server downloads for display. |
| `DREYMAIL_MAX_UPLOAD_MB` | no | `25` | Largest total attachment upload when composing. |
| `DREYMAIL_CACHE` | no | `true` | Keep a local copy of each account's newest INBOX and Sent mail, see [Mail cache](#mail-cache). `false` asks the mail server every time. |
| `DREYMAIL_CACHE_MESSAGES` | no | `2000` | Newest messages kept per cached folder (50–100000). Older mail is fetched from the mail server as you scroll. |
| `DREYMAIL_CACHE_MAX_BODY_MB` | no | `1` | Largest message whose content is kept (`0`: keep no message content). |
| `DREYMAIL_CACHE_ACCOUNT_MB` | no | `200` | Message content kept per account; the least recently read goes first. |
| `DREYMAIL_VAPID_SUBJECT` | no | `DREYMAIL_BASE_URL` if it is `https://`, else `mailto:postmaster@<host>` | Contact sent to push services (Apple, Google, Mozilla) with every notification: a `mailto:` or `https:` URL. |
| `DREYMAIL_DEFAULT_*` | no | – | Starting values for new mail accounts, see [Default account settings](#default-account-settings). |
| `LOG_LEVEL` | no | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `DREYMAIL_DEV_LOGIN` | no | `false` | Development only: log in as a local dev user without a password or OIDC. Ignored when `NODE_ENV=production` (always set in the image). |
| `DREYMAIL_DEV_ALLOWED_HOST_SUFFIX` | no | – | Development only: also serve the dev server on any host ending in this suffix (see [Development](#development)). Ignored when `NODE_ENV=production` and by the production build. |

### Default account settings

If your users all get their mail from the same provider, set the server details once and the
**Add account** form starts out filled in. Users can still change every field.

| Variable | Description |
| --- | --- |
| `DREYMAIL_DEFAULT_IMAP_HOST` / `DREYMAIL_DEFAULT_SMTP_HOST` | Incoming and outgoing server. |
| `DREYMAIL_DEFAULT_IMAP_SECURITY` / `DREYMAIL_DEFAULT_SMTP_SECURITY` | `tls` (default), `starttls` or `none`. |
| `DREYMAIL_DEFAULT_IMAP_PORT` / `DREYMAIL_DEFAULT_SMTP_PORT` | Defaults to the standard port for the security mode (993/143, 465/587). |
| `DREYMAIL_DEFAULT_MAIL_USERNAME` | Username for IMAP and SMTP. |
| `DREYMAIL_DEFAULT_EMAIL` | Email address of the account. |
| `DREYMAIL_DEFAULT_DISPLAY_NAME` | Name shown to recipients. |
| `DREYMAIL_DEFAULT_ACCOUNT_LABEL` | Account label in the sidebar. |
| `DREYMAIL_DEFAULT_MAIL_PASSWORD` | Optional shared password for IMAP and SMTP. |

All of them except the password can contain tokens that are filled in for each user:

- `{username}`: the login username of password users; for OIDC users the provider's
  `preferred_username` (or, without one, the part of their email address before the `@`).
- `{email}`: the user's email address from login.
- `{name}`: the user's name from login.

If a user has no value for a token (an OIDC user without an email address, say), the field starts
empty instead. A misspelled token stops the server from starting.

```env
DREYMAIL_DEFAULT_IMAP_HOST=imap.example.com
DREYMAIL_DEFAULT_SMTP_HOST=smtp.example.com
DREYMAIL_DEFAULT_MAIL_USERNAME={username}@example.com
DREYMAIL_DEFAULT_EMAIL={username}@example.com
DREYMAIL_DEFAULT_DISPLAY_NAME={name}
```

The default password is taken literally and never sent to the browser. When a user leaves the
password blank, the server fills it in, but only for the default server: if the user points the
account at a different host, they have to enter that host's password themselves.

### Notifications

DreyMail is an installable web app (PWA) and can send notifications for new mail through the
browsers' standard Web Push services. No native app, no Firebase or Apple developer account and
no extra configuration are needed. The push keys (VAPID) are derived from
`DREYMAIL_SECRET_KEY`. HTTPS is required.

Each user turns notifications on per device in **Settings → Notifications**:

- **Android** (Chrome, Firefox, Edge, Samsung Internet) and **desktop browsers**: turn the switch on.
  Installing the app ("Add to Home screen" / "Install app") is optional.
- **iPhone and iPad** (iOS/iPadOS 16.4 or newer): open the site in Safari, tap *Share → Add to
  Home Screen*, open DreyMail from the Home Screen, then turn the switch on. A Safari tab can't
  receive notifications.

What you get:

- One notification per new **unread** message in any account's INBOX (several messages that
  arrive together are summarised in one). Tapping it opens the message.
- Nothing while the app is open and focused on any of your devices, since the list updates live
  anyway.
- Users choose whether notifications show **sender and subject** or only "New message" and the
  account name. The payload is end-to-end encrypted to the device (RFC 8291), but it does pass
  through Apple's, Google's or Mozilla's push service.
- Notifications close themselves on all your devices once their messages are read or moved out of
  the inbox, in DreyMail or in any other mail client (within the 24 hours a notification is
  kept, and not across a server restart). Not on iPhone and iPad: Apple revokes notifications for
  sites that send pushes which show nothing.
- The app icon shows the number of unread messages across all inboxes, where the platform
  supports badges.
- On Android, the notification header shows the browser's icon and name unless the browser
  installs the app as a real Android app (a "WebAPK", as Chrome does). Browsers such
  as Vivaldi add a home screen shortcut instead, so their notifications are attributed to
  the browser; the squirrel still appears in the status bar and as the notification's picture.

How it works: while a user has notifications on at least one device, the server keeps one IMAP
IDLE connection per account open on INBOX, even when no browser is open. Mind your provider's
connection limits (Gmail allows 15 simultaneous IMAP connections per account). The server
remembers the newest INBOX UID it has notified about, so after a restart it reports mail that
arrived while it was down, but never old mail when notifications are switched on. Subscriptions
that the push service reports as expired are removed automatically. Signing out stops
notifications on that device.

### Snooze

Snoozing moves a message to the account's **Snoozed** folder until the time you pick. DreyMail
uses the folder the server marks as Snoozed (the IMAP `\Snoozed` attribute from RFC 9979), or a
folder named "Snoozed", and creates one if there is none. IMAP has no way to store *when* a message
should come back, so DreyMail keeps the wake-up time in its database and runs the timer itself.

When the time comes, the message goes back to INBOX as unread, with the current time as its arrival
date, so it is at the top of the list. Messages larger than `DREYMAIL_MAX_MESSAGE_MB` are moved
back as they are and keep their old date. Then:

- your devices with notifications on get a "Back from snooze" notification (same content setting
  as for new mail; nothing while the app is open and in front of you);
- open browser windows show a notice with a link to the message.

In the Snoozed folder each message shows when it comes back. Open one to **Unsnooze** it (back to
the inbox right away) or snooze it again to change the time. A snooze can be undone from the
notice that confirms it. Snoozes that came due while the server was down are handled when it
starts. A message you move out of the Snoozed folder yourself, in DreyMail or another mail app,
stays where you put it.

### Login

Two login methods are available, alone or together:

- **Username and password.** On by default when no OIDC provider is configured. With OIDC, turn
  it on with `DREYMAIL_PASSWORD_LOGIN=true`. Usernames are case-insensitive (an email address
  works); passwords need at least 10 characters and are stored as scrypt hashes. By default only
  the first person to open a fresh instance can create an account (`DREYMAIL_REGISTRATION=first`).
  To let others sign up, set `DREYMAIL_REGISTRATION=open` (for a while, or permanently on a
  private network), then back to `closed`. With open registration on a public instance, also set
  `DREYMAIL_BLOCK_PRIVATE_MAIL_HOSTS=true` so strangers can't point IMAP/SMTP at your LAN. After
  10 wrong passwords for one username, or 30 from one IP address, logins are refused for 15 minutes. Users change their password in **Settings**.
- **OpenID Connect** (Authentik, Keycloak, …): see below.

Password users and OIDC users are separate accounts, even if they share an email address.

Sessions are encrypted cookies valid for 14 days. They can't be revoked one by one: changing a
password doesn't sign out other devices. Changing `DREYMAIL_SECRET_KEY` signs everyone out (and
makes stored mail passwords unreadable).

### OIDC setup

Create an OAuth2/OpenID Connect application (confidential client, authorization code flow) with:

- Redirect URI: `https://mail.example.com/auth/callback`
- Post-logout redirect URI (optional): `https://mail.example.com/`
- Scopes: `openid email profile`

**Authentik:** create an *OAuth2/OpenID Provider* and an *Application*. The issuer URL looks like
`https://auth.example.com/application/o/<application-slug>/`. Use Authentik's application
bindings/policies to decide who may log in.

**Keycloak:** create a client with *Client authentication* on and *Standard flow* enabled. The
issuer URL looks like `https://auth.example.com/realms/<realm>`.

Anyone your provider lets through can use DreyMail. Users are identified by issuer and `sub`
claim, and each user sees only the mail accounts they added themselves. DreyMail uses PKCE,
`state` and `nonce`, and supports RP-initiated logout if the provider advertises an
`end_session_endpoint`.

### Reverse proxy notes

- Terminate TLS at the proxy and set `DREYMAIL_BASE_URL` to the public `https://` URL and
  `DREYMAIL_TRUST_PROXY=true`.
- **WebSockets** must be proxied on `/api/ws` (live updates). Nginx:

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;  # map $http_upgrade, see nginx docs
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 1h;
      client_max_body_size 30m;   # attachments
  }
  ```

  Caddy and Traefik proxy WebSockets automatically.
- Allow request bodies at least as large as `DREYMAIL_MAX_UPLOAD_MB` (plus a little overhead).
- Serve DreyMail on its own (sub)domain, not under a path prefix.

### Mail cache

Asking the mail server for everything on every click is slow: one page of a folder takes several
IMAP round trips, and finding the rest of each conversation in the Sent folder means header
searches that some servers are slow at. So DreyMail keeps a copy of the newest messages
(`DREYMAIL_CACHE_MESSAGES`, 2000 by default) of each account's **INBOX** and **Sent** folder:
sender, subject, snippet, flags and the headers that tie conversations together. It also keeps the
content of messages you have opened, and loads the newest unread ones ahead, up to
`DREYMAIL_CACHE_MAX_BODY_MB` per message and `DREYMAIL_CACHE_ACCOUNT_MB` per account. The limits
are server settings; users can't change them.

The mail server stays the source of truth:

- Every action (read, flag, move, delete, send) goes to the mail server first; the copy is updated
  once the server has done it.
- The copy follows the server. While INBOX is watched (a browser is open, or notifications are on),
  every change reported by IDLE is fetched right away, so the inbox shows without asking the server.
  Otherwise, and for Sent, a listing first gives the server a moment (1.5 s) to report changes, and
  shows the copy if it is slower; the list updates by itself when the changes arrive. **Refresh**
  always checks with the server first. Changes are fetched incrementally: new messages, changed
  flags (only those since the last check where the server supports CONDSTORE) and messages that are
  gone. A new UIDVALIDITY starts the folder over.
- Other folders, searches, scrolling past the copy, attachments and folder counts always go to the
  mail server.
- The copy is disposable. It is a separate file (`cache.db`), and anything wrong with it (a damaged
  file, an entry that doesn't decrypt, another secret key, a new format) just empties it, or the
  folder concerned, and it is filled again from the server. Deleting the file while DreyMail is
  stopped is always safe.

What is stored and how: subjects, addresses, snippets, Message-IDs, References and message content
are encrypted with AES-256-GCM (a key derived from `DREYMAIL_SECRET_KEY`), each entry bound to its
user, account, folder and message, so a copied row doesn't decrypt elsewhere. Conversations are
matched through keyed hashes (HMAC) of the Message-IDs, not the IDs themselves. Readable in the file
are only what queries need: folder names, UIDs, arrival times, sizes and the read/flagged/answered/
draft flags. An account's copy is deleted with the account, or when it is pointed at another server
or login.

## Security model

Every message is assumed to be hostile.

- **HTML mail** is sanitized on the server with `sanitize-html` and a `postcss`-based CSS
  sanitizer. Removed: scripts, event handlers, forms, frames, objects, SVG/MathML,
  meta/base/link, comments, `javascript:`/`data:` links, CSS expressions, `@import`,
  behaviours, and anything hidden behind CSS escapes. Links are limited to
  `http`/`https`/`mailto`/`tel` and open in a new tab with `noopener noreferrer`. `mailto:` links
  are pointed at the app's own composer (`/?mailto=…`) just before display.
- The result is rendered in an `<iframe sandbox>` **without** `allow-scripts` and
  `allow-same-origin`. That gives it an opaque origin, so it can't reach the app, its cookies or
  storage. A strict Content-Security-Policy inside the frame (`default-src 'none'; img-src data:`)
  blocks scripts, forms, frames and **every** network request: the rendered message never
  contacts any server, which also means it works behind cookie-based auth proxies.
- **Remote content is blocked by default.** "Load images" makes the server download the images
  (`<img>`, `background=` and CSS `url()`) and embed them as `data:` URIs, so senders never see the
  reader's IP address, cookies or referrer. The fetcher only fetches `http(s)` on ports 80/443.
  It resolves DNS itself and refuses loopback/private/link-local/CGNAT/ULA/multicast/reserved
  addresses, including IPv4-mapped IPv6 and IP literals. It connects to the address it checked
  (no DNS-rebinding window), re-checks every redirect, and only accepts raster image types (no
  SVG). Limits per message: 6 parallel fetches, 10 MB per image, 15 MB and 100 images in total,
  and a 20 s budget. Anything over a limit, failing or blocked is left out, keeping its size and
  alt text as a placeholder. Fetched images sit in a small in-memory cache (per user, 10
  minutes, 64 MB) so toggling or reopening a message doesn't download them again.
- **Sender-domain allowlist.** The server decides when it fetches a message: if the From domain
  is on the user's list (exact match or a subdomain; case-insensitive, IDN normalised to
  punycode), images load automatically through the same fetcher. From is easy to forge, so as a
  cheap guard nothing auto-loads when the topmost `Authentication-Results` header (the one added
  by your own mail server) records `dmarc=fail` for the From domain; the user can still click
  "Load images". Without that header, or with `pass`/`none`, the allowlist applies as normal.
- `cid:` images are inlined as `data:` URLs. Attachments are always served as downloads
  (`Content-Disposition: attachment`, `application/octet-stream`, `nosniff`, sandbox CSP).
- The app sends a strict CSP (`script-src 'self'`), `frame-ancestors 'none'`, `nosniff`,
  `no-referrer`, and other hardening headers.
- **Credentials:** AES-256-GCM with a random IV, and the ciphertext bound to its user and account
  (AAD), so a copied database row doesn't decrypt elsewhere. Passwords are never returned by the
  API.
- **Cached mail** is encrypted the same way; see [Mail cache](#mail-cache) for what is readable.
- **Notifications:** push subscription endpoints come from the browser, so the server treats
  them like remote image URLs. It accepts any HTTPS push service (so every browser's push service
  works), but only on the standard port, without credentials, IP literals or reserved names. It
  resolves DNS itself, refuses internal addresses, connects to the address it checked and never
  follows redirects. Payloads are encrypted for the receiving device. The service worker
  only shows notifications. It caches nothing and only opens paths of the app itself.
- **Sessions** are encrypted, HttpOnly, SameSite=Lax cookies. State-changing API calls also
  require a custom header, which cross-site pages can't send. WebSocket upgrades check
  `Origin`.

## Development

Requirements: Node.js ≥ 22.13 (uses the built-in `node:sqlite`) and Docker (for integration
tests).

```sh
npm install
cp .env.example .env          # set DREYMAIL_SECRET_KEY; without OIDC you get password login (or use DREYMAIL_DEV_LOGIN=true)
PORT=5173 npm run dev         # Vite on $PORT, backend on $PORT+1 (proxied under /api and /auth)
```

In a git worktree (`git worktree add`), `npm run dev` also reads the main checkout's `.env`, so one
file serves every worktree. A `.env` in the worktree overrides single values from it, and real
environment variables override both. The database is not shared: each worktree keeps its own
`./data` (a relative `DREYMAIL_DATA_DIR` is relative to the worktree), because branches with
different migrations would break each other's schema.

If you open the dev server through a reverse proxy, set `DREYMAIL_BASE_URL` to that public URL.
Vite only accepts that host name (plus `localhost`).

If the same setup is reached through several proxied hostnames that differ only in a leading part
(e.g. one per port: `5173--myworkspace--me.dev.example.com`, `40140--myworkspace--me.dev.example.com`),
also set `DREYMAIL_DEV_ALLOWED_HOST_SUFFIX=--myworkspace--me.dev.example.com`. The suffix must
start with `.` or `--` and is matched exactly at the end of the host name, so lookalikes such as
`…dev.example.com.evil.test` are refused. In development the WebSocket origin check then follows
the request host, and dev login works on each of those hosts (cookies are per host, so log in once
per host). OIDC still needs the real `DREYMAIL_BASE_URL`: its redirect URI is built from it, so OIDC
logins always return to that one host.

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-check server and web client. |
| `npm test` | Unit tests: sanitizer (hostile fixtures), MIME parsing, credential encryption, SSRF guards, unified-inbox merging, conversations, the mail cache, Web Push encryption (RFC 8291 test vector), notifications, snooze scheduling, the web client's pure logic and the release version script. |
| `npm run test:integration` | Starts a throwaway [GreenMail](https://greenmail-mail-test.github.io/greenmail/) container (Docker), runs the full HTTP API against real IMAP/SMTP, and removes the container. Also builds the image's base stage and checks the container entrypoint (`PUID`/`PGID`, data directory ownership). |
| `npm run build` | Compiles the server to `dist/server` and the web client to `dist/web`. |
| `npm start` | Runs the production build. |

### Releasing

Versions have two parts, `MAJOR.MINOR`, and roll over after `.9`: `1.0`, `1.1`, … `1.9`, `2.0`.
`package.json` holds the version as `MAJOR.MINOR.0` because npm needs three parts.

Every push to `main` runs the **Release** workflow. It always runs the tests. When the version in
`package.json` has no `v` tag yet, it also pushes the image (tagged with the version and
`latest`), then creates the `vX.Y` tag and a GitHub Release with generated notes. To release:

```sh
scripts/release-version.sh next      # prints the next version, e.g. 1.1
# set package.json and package-lock.json to 1.1.0, add the CHANGES.md entry, commit, push to main
```

Pull requests and other branches run the **CI** workflow (tests only). Both stay within GitHub's
free tier for public repositories.

### Architecture

```
server/src
  app.ts            Fastify setup, security headers, static files
  auth/             OIDC login (openid-client), password login (scrypt) and encrypted session cookies
  db.ts             SQLite store: users, encrypted accounts, preferences, recent recipients, image
                    allowlist, push subscriptions, snoozes
  cache/store.ts    Mail cache: encrypted copies of INBOX and Sent (a separate, disposable SQLite file)
  cache/sync.ts     Keeps the mail cache in step with the IMAP server
  imap/pool.ts      Lazy per-account IMAP connections with idle timeout; IDLE watchers
  imap/mail.ts      Folders, unified listing (k-way merge with per-account UID cursors), actions
  imap/related.ts   Finding the rest of a conversation (replies in Sent, older messages)
  mail/sanitize.ts  HTML sanitizer; mail/css.ts CSS sanitizer
  mail/compose.ts   MIME building (Nodemailer MailComposer); mail/send.ts SMTP + Sent/Drafts
  mail/snooze.ts    Snoozed folder, wake-up timer, putting mail back into INBOX
  net/              SSRF guards, the server-side remote image fetcher and contact pictures
  push/             Web Push (VAPID, RFC 8291 encryption) and new-mail notifications
shared/             Types, conversation grouping and the sandboxed iframe document builder
web/src             React + TanStack Query client
docker/             Container entrypoint (drops to PUID:PGID)
scripts/            Dev server launcher, icon generator, release version script
```

Paging the unified inbox: each source (account + folder) is consumed newest-UID-first. Pages are
merged by date, and the cursor stores, per source, the UIDVALIDITY and the lowest UID returned so
far. If a folder's UIDVALIDITY changes, the server tells the client to reload the list. Message
actions carry the UIDVALIDITY too and are refused (HTTP 409) if it no longer matches. Cached
folders use the same cursors, so a page can come from the cache and the next from the IMAP server.

## Limitations

- Conversations bring together the listed folder and Sent. A message of the conversation in
  another folder (moved there by a filter, say) isn't shown with it.
- Live updates (IDLE) cover each account's INBOX. Other folders refresh when you open them, when
  the window regains focus, and every couple of minutes.
- Sent copies are appended without the Bcc header.
- Snoozing is a DreyMail feature: other mail apps see the messages in the Snoozed folder, but only
  DreyMail brings them back, and only while it is running (late ones come back when it starts).
  A woken message is a new copy in INBOX, so it gets a new UID.
- No OAuth2 IMAP (XOAUTH2 for Gmail/Microsoft 365). Use app passwords where the provider
  supports them.
- Out of scope: server-side filters, calendar/contacts, JMAP, PGP, local full-text search.

## License

DreyMail is licensed under the [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0-only), the same license as Ratatoskr. See [`NOTICE`](NOTICE) for the attribution
requirements and [`CHANGES.md`](CHANGES.md) for what changed from upstream. If you run a modified
version as a service for others, you must offer them its source code.
