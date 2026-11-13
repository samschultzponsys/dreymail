# Changes from upstream

DreyMail is a modified version of [Ratatoskr](https://github.com/magnuspihl/Ratatoskr) by Magnus
Pihl, licensed AGPL-3.0-only. This file is the dated record of our modifications, as AGPL-3.0
§5(a) requires. Every change to upstream material gets an entry here, newest first.

**Starting point:** upstream `main` at
[`e2abaa4c585a2e0edc8a09b082208941c32afcdc`](https://github.com/magnuspihl/Ratatoskr/commit/e2abaa4c585a2e0edc8a09b082208941c32afcdc)
(2026-10-27, "Merge pull request #29 … the cache miss is still happening sometimes"). The full
upstream history is kept in this repository.

Upstream merges are recorded here too, with the upstream commit they brought in.

---

## 2026-11-13 (v1.4): administration and sign-in settings in the UI

- **Administrators:** `users.is_admin` (migration: the oldest existing user becomes admin; the
  first user of a new instance is admin) and `DREYMAIL_ADMIN_USERS` (usernames or emails that are
  always admins). `Me.admin` tells the client. Files: `server/src/db.ts`, `server/src/config.ts`,
  `server/src/routes/api.ts`, `shared/types.ts`.
- **Users admin:** new `server/src/routes/admin.ts` with `/api/admin/users` (list, add password
  user, make/remove admin, set password, remove user with their data; never yourself, never the
  last admin). Settings → Users (new `web/src/components/AdminSettings.tsx`).
- **Sign-in settings in the UI:** new `server/src/loginSettings.ts` stores OIDC (client secret
  encrypted), password login and registration in the new `instance_settings` table. Environment
  variables override field by field and show as locked. `server/src/auth/routes.ts` reads the
  settings per request (no restart; OIDC discovery resets on change); password routes are always
  registered and check the setting. `/api/admin/login` (get, save with lock-out protection) and
  `/api/admin/login/test` (OIDC discovery check). Settings → Sign-in.
- Wiring and UI: `server/src/app.ts`, `web/src/App.tsx`, `web/src/api.ts`,
  `web/src/components/SettingsDialog.tsx`, `web/src/styles.css`. Tests: `server/test/admin.test.ts`.

## 2026-11-13 (v1.3): signatures, settings tabs

- **Signatures:** new `signatures` and `signature_accounts` tables (an account uses at most one
  signature, so one can be shared or per-inbox), store methods and `GET/POST/PUT/DELETE
  /api/signatures` with server-side HTML sanitizing (`server/src/db.ts`,
  `server/src/routes/api.ts`, `shared/types.ts`). Settings → Signatures to manage them (new
  `web/src/components/SignaturesSettings.tsx`). The composer inserts the From account's signature
  and swaps it when the account changes (new `web/src/signature.ts`;
  `web/src/components/Composer.tsx`, `web/src/api.ts`, `web/src/hooks.ts`). Tests:
  `server/test/signatures.test.ts`, `web/test/signature.test.ts`.
- **Composer colour:** the composer takes on the From account's colour.
- **Settings tabs:** General, Signatures, Notifications, Images, Password
  (`web/src/components/SettingsDialog.tsx`, `web/src/styles.css`).

## 2026-11-13 (v1.2): DreyMail name, account colours, All inboxes switch

### All inboxes on/off
- New preference `unifiedInbox` (default on), in Settings as "Show “All inboxes”". Off: the
  sidebar hides "All inboxes" and the app opens on the first account's inbox. Files:
  `shared/types.ts`, `server/src/db.ts`, `server/src/routes/api.ts`, `web/src/App.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/components/SettingsDialog.tsx`,
  `server/test/preferences.test.ts`.

### Account colours
- The first account defaults to DreyMail cyan; ten presets (no browns) plus a colour wheel for any
  colour (`web/src/util.ts`, `web/src/components/AccountsDialog.tsx`, `web/src/styles.css`).
- While one account is open, the whole app takes on its colour: buttons, accent text, unread dots,
  selection, focus rings, a light tint on the page and sidebar, and the browser/Android bar. Text
  and button labels are adjusted to stay at 4.5:1 contrast for any colour. Message content is not
  tinted. New `web/src/accountTheme.ts` and `web/test/accountTheme.test.ts`; changes in
  `web/src/App.tsx` and `web/src/themeColor.ts`.


### Name: DreyMail
- The product name is now written **DreyMail** everywhere people read it: page and app title,
  PWA manifest, login page, sidebar, settings text, test notification, release titles, README,
  NOTICE and docs. Technical identifiers stay lowercase `dreymail` (repo, image, package, container,
  paths). Files: `web/index.html`, `web/public/manifest.webmanifest`, `web/src/components/Login.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/components/SettingsDialog.tsx`,
  `server/src/push/service.ts`, `scripts/icons.mjs` (+ regenerated SVGs),
  `.github/workflows/release.yml`, `README.md`, `NOTICE`, `CLAUDE.md`, `ROADMAP.md`, and the
  notice headers of previously modified files.
- **Attribution fix:** the v1.0 rename had wrongly turned the Ratatoskr credit in
  `web/src/components/SettingsDialog.tsx`'s header and the README's license line into "dreymail".
  Both credit Ratatoskr again.

### License notices in icon files

- `scripts/icons.mjs` now writes an AGPL notice into every generated SVG
  (`web/icons-src/*.svg`, `web/public/favicon.svg`, `web/public/brand-*.svg`, `branding/*.svg`).
  The files that replace upstream's squirrel icons at the same path also carry a "Modified by"
  line. The PNG icons can't hold comments; this entry and the v1.1 entry cover them. Also covered
  here: the v1.1 version bump in `package.json` / `package-lock.json`.

## 2026-11-13 (v1.1): dreymail icon and cyan accent

- **Icon:** the app now uses dreymail's own icon, a cyan envelope in an indigo drey on night navy,
  everywhere: favicon, installed-app (PWA) icons, Android maskable icon, iOS home-screen icon and
  the notification badge. The favicon follows the system light/dark setting (day: pale
  periwinkle tile; night: navy tile). Generated by `scripts/icons.mjs` (rewritten); the outputs
  are `web/icons-src/*.svg`, `web/public/favicon.svg`, `web/public/brand-day.svg`,
  `web/public/brand-night.svg`, `web/public/icons/*.png` and `branding/*`. Upstream's squirrel
  source `web/icons-src/original.svg` was removed. The running-squirrel phone animation is kept
  (now cyan).
- **In-app logo:** the sidebar and login page show a day or night logo matching the app's own
  theme setting (`web/src/components/Sidebar.tsx`, `web/src/components/Login.tsx`,
  `web/src/styles.css`).
- **Accent colour:** orange became cyan in `web/src/styles.css`: filled buttons `#22d3ee` with
  navy labels, accent text `#0e7490` (light) / `#67e8f9` (dark), cyan unread dots, selection
  tints and focus rings.
- **Tests:** `web/test/icons.test.ts` checks the new icon, palette and day/night logos instead of
  the squirrel and orange.

## 2026-11-13 (v1.0): project setup

No changes to app behaviour or features.

- **Attribution and license:** added `NOTICE` (attribution to Ratatoskr, upstream commit, and an
  AGPL §7(b) attribution term for dreymail's own additions), this `CHANGES.md`, `CLAUDE.md` and
  `ROADMAP.md`. `LICENSE` is unchanged.
- **Branding (names only):** user-visible "Ratatoskr" text became "dreymail" in
  `web/index.html`, `web/public/manifest.webmanifest`, `web/src/components/Login.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/components/SettingsDialog.tsx` and the test
  notification in `server/src/push/service.ts`. `package.json` `name` is now `dreymail`
  (license field unchanged).
- **Icon:** new dreymail icon in `branding/` (not yet used by the app; the app still ships the
  upstream squirrel icons).
- **Docker / deployment:** example `docker-compose.yml` rewritten for an inline-environment,
  reverse-proxied setup with image `ghcr.io/samschultzponsys/dreymail`. Dockerfile unchanged.
- **CI / releases:** `.github/workflows/release.yml` now releases on push to `main` when the
  version in `package.json` has no tag yet, using two-part versions (`1.0` … `1.9`, `2.0`).
  `.github/workflows/ci.yml` no longer runs on `main` (the release workflow tests it).
  `scripts/release-version.sh` and `server/test/releaseVersion.test.ts` switched to `MAJOR.MINOR`.
- **README:** rewritten for dreymail with a Credits / Origin section. The upstream documentation
  is kept and rebranded.
