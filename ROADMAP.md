<!-- dreymail. Copyright (C) 2026 samschultzponsys.
     Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE. -->

# DreyMail roadmap

What DreyMail does and what is planned, kept up to date with each release. Done items name the
version they arrived in; details are in [`CHANGES.md`](CHANGES.md).

**Use case:** a self-hosted portal for several mail accounts per user (Gmail, Outlook / Microsoft
365, Purelymail, any IMAP/SMTP), in desktop browsers, the Linux and Windows apps and on Android. No
iOS requirement. Mail stays on the providers; at most a minimal encrypted cache.

## Planned

### Mail
- [ ] Calendar: DreyMail calendars shared between users, a calendar list with per-account
      checkboxes, month/week/day/agenda views.
- [ ] Calendar sync with Google, Outlook and CalDAV; RSVP from invitations.
- [ ] Copy verification codes (in the list and from notifications).
- [ ] Unsubscribe button (List-Unsubscribe, one-click where offered) and block sender.
- [ ] Send later and undo send.
- [ ] Account health alerts (sign-in expired, mailbox unreachable, quota).
- [ ] Rules with a match preview; automatic tabs (Personal / Updates / Newsletters).
- [ ] AI assistant learning mode: per mailbox, for up to a month, learns from how you handle mail and
      suggests rules; a review screen when it ends.
- [ ] AI assistant actions: draft reply, forward, unsubscribe; Outlook categories via Microsoft Graph.
- [ ] Per-account "save copy to Sent" default by provider (the per-account setting exists; Gmail and
      Outlook sign-in accounts already let the provider file sent mail).
- [ ] Gmail specifics: multi-label view and archive vs. delete semantics over IMAP.

### Security and sessions
- [ ] Passkey / fingerprint sign-in and app lock (WebAuthn), with device PIN fallback.
- [ ] Sliding sessions on trusted devices (today a session lasts 14 days from sign-in).

### Configuration
- [ ] Remaining settings in the UI (account defaults, cache, push), stored in the database, with
      compose-file environment variables overriding them and shown as locked. Bootstrap values
      (secret key, data dir) stay env-only.

### Branding
- [ ] Decide whether the running-squirrel phone animation stays or gets its own DreyMail motion.

### Not planned
- JMAP: only a few providers offer it (mainly Fastmail and Stalwart), and they also offer IMAP,
  which DreyMail already supports. It would mean a second mail engine next to IMAP.
- Export of mail: mail stays on its server.

## Done

### Accounts, look and layout
- [x] DreyMail's own icon and brand (1.1), name and identity throughout (1.5).
- [x] "All inboxes" can be turned off (1.2).
- [x] Per-account colors (presets or any color); the whole app recolors per open account (1.2).
- [x] Per-account icons, 38 built in, shown in the sidebar and notifications (2.9); your own
      uploaded picture as an icon, with size, position and background (3.0).
- [x] Signatures per account or shared across accounts (1.3).
- [x] Interface size per device; tablet and foldable two-pane layout (2.0).
- [x] Your name and profile picture (initials in the app color without one) at the bottom left,
      showing photo, name or both (1.7, 2.5–2.8).
- [x] Version and changelog at the bottom left, with an update dot for administrators (1.8).
- [x] Settings grouped into This device / Your account / Administration (2.2, 2.5).
- [x] "Add a mailbox to get started" screen (2.5).

### Providers and mail
- [x] Outlook.com, Hotmail and Microsoft 365 with Microsoft sign-in (2.2).
- [x] Gmail with Sign in with Google, next to app passwords (2.3).
- [x] Search with a visual filter builder (accounts, where, from/to, subject, text, dates, size,
      attachments, starred, replied) and saved searches as smart folders (2.4).

### Apps and notifications
- [x] Desktop apps for Linux (deb, rpm, flatpak) and Windows, with per-account colored
      notifications and an updater that knows how it was installed (1.6).
- [x] Android app with instant, end-to-end encrypted notifications (Firebase), a notification
      channel per account (own sound), tinted and colored icons, and an in-app updater (1.9, 2.0).

### AI mailbox assistant
- [x] Plain-language rules with exact conditions, run on new mail, test, history with undo; AI
      connections (Anthropic, Gemini, OpenAI-style, local LM Studio/Ollama/…) per user or shared,
      per mailbox, with daily limits; accuracy slider; at-your-own-risk notice; permission and
      per-user switch (3.1).
- [x] Clean up: sort existing mail in batches with progress; senders grouped by volume with archive
      all, always archive and one-click unsubscribe (3.2).

### Administration and security
- [x] Sign-in settings (OIDC, password login, registration) in the UI, env overrides locked (1.4).
- [x] User management in the app (1.4); roles with permission flags (Superadmin, User and custom
      roles) and per-flag checks on every administrative action (2.5).
- [x] Outlook, Google and Android (Firebase) setup in the UI with walkthroughs (2.0–2.3).

### License compliance
- [x] Source code link (AGPL §13) with the attribution, on the sign-in page, in What's new and in
      Settings (3.2).

### Releases
- [x] Every version gets a GitHub Release with the image, desktop apps and APK; runs queue per
      version; Node 24 everywhere (2.7, 2.8).
