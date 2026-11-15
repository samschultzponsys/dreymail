<!-- dreymail. Copyright (C) 2026 samschultzponsys.
     Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE. -->

# DreyMail roadmap

Context for future work. **Nothing here is implemented yet.**

**Use case:** a single-user personal portal for several Gmail and Purelymail accounts. It must
work in desktop browsers (Windows, Fedora, Debian) and on Android. No iOS requirement. Mail stays
on the providers; at most a minimal encrypted cache.

## Accounts and UI
- [ ] Option to hide the unified "All inboxes" view. Accounts must feel clearly separate.
- [ ] Per-account notification icon (and accent color where the platform allows).
- [ ] Per-account custom icon in the sidebar, not just a color.

## Security and sessions
- [ ] Biometric/PIN app lock via WebAuthn (fingerprint on open/after idle, device PIN fallback)
      on top of OIDC.
- [ ] Long-lived sessions: no re-prompting for login on trusted devices.

## Providers
- [ ] Verify Gmail label/folder mirroring with Inbox Zero labels; handle Gmail IMAP semantics
      (multi-label, archive vs. delete).
- [ ] Per-account "save copy to Sent" default: off for Gmail, on/verified for Purelymail.
- [x] Microsoft sign-in for Outlook.com, Hotmail and Microsoft 365 (v2.2: IMAP with OAuth, sending
      through Microsoft Graph).
- [x] Search with a visual filter builder and saved searches (v2.4).
- [ ] Calendar: DreyMail calendars shared between users, per-account checkboxes (v2.5); sync with
      Google, Outlook and CalDAV, RSVP from invites (v2.6).
- [ ] Copy verification codes, unsubscribe button, block sender, send later, undo send, account
      health alerts, passkey/fingerprint login.
- [ ] Rules/filters with a match preview; automatic tabs (Personal / Updates / Newsletters).
- [x] Sign in with Google for Gmail (v2.3), next to app passwords.

## Configuration and deployment
- [ ] All remaining configuration possible in the UI (default account settings, cache,
      push, …), stored in the database. Values set as environment variables in the compose file
      (inline, no `.env` file) override the UI values, and the UI shows them as locked/"set by
      environment". Only bootstrap values (secret key, data dir) stay env-only.
- [x] DreyMail's own names everywhere: `DREYMAIL_*` environment variables, database file, keys
      (v1.5, with a one-time upgrade of existing data).
- [x] Sign-in settings (OIDC, password login, registration) in the UI (v1.4).

## Branding
- [x] Replace logo/icons with own artwork (v1.1: cyan envelope in an indigo drey).
- [ ] Decide whether the running-squirrel phone animation stays, or gets its own DreyMail motion.

## License compliance
- [ ] "Source code" link in the UI (AGPL §13), needed before anyone else uses an instance. Link
      to this repository at the running version, and show the DreyMail attribution next to it.
