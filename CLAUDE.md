# CLAUDE.md: working on dreymail

dreymail (pronounced "DRAY-mail"; a drey is a squirrel's nest) is a self-hosted webmail portal. It
is a modified version of **Ratatoskr** by Magnus Pihl (https://github.com/magnuspihl/Ratatoskr).
It is an independent project, not a GitHub fork, and does not contribute upstream. It started from
upstream commit `e2abaa4c585a2e0edc8a09b082208941c32afcdc` (2026-10-27). The full upstream history
is kept.

Owner: samschultzponsys. Repo: https://github.com/samschultzponsys/dreymail (public).

## Hard rules

### License (AGPL-3.0-only, inherited; never change it)
- **Never edit, shorten or replace `LICENSE`.**
- **Never remove or reword existing copyright/license notices**: the `"license"` field in
  `package.json`, the credit in `NOTICE` and `README.md`, or any notice in a file header. New
  credit goes *next to* existing credit, never in place of it.
- **Mark every modified upstream file** (AGPL §5(a)). Under the file's existing header (or at the
  top if there is none), add or extend:
  ```
  // Part of dreymail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
  // Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
  // Modified by samschultzponsys, YYYY-MM-DD: <one-line summary>
  ```
  If the file already has a "Modified by" line, add a new dated line below it rather than
  replacing it. Use the file type's comment syntax (`#`, `<!-- -->`). Files that can't hold
  comments (JSON, PNG) are covered by their `CHANGES.md` entry.
- **New files** get a standard header:
  ```
  // dreymail. Copyright (C) YYYY samschultzponsys.
  // Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.
  ```
- **Update `CHANGES.md`** with every change: a dated entry with the version, listing what changed
  and in which files.
- **Network-use source offer (AGPL §13):** if anyone other than the owner ever uses a deployed
  instance, the UI **must** link to this project's source code (the repo URL, at the exact
  version running). It's not built yet; it's on `ROADMAP.md` and must ship before the instance is
  shared.
- `NOTICE` carries an AGPL §7(b) additional term: anyone redistributing or hosting dreymail
  keeps the NOTICE attribution (dreymail + Ratatoskr) and the in-UI attribution/source link intact.

### Git
- **Never push to `upstream`.** Its push URL is set to `DISABLED`; leave it that way.
- Push to `origin main` without asking (owner's standing instruction). Commit in logical steps.
- Don't push upstream's tags (e.g. `v0.1.0`); dreymail has its own version line. Push branches by
  name, never `--tags`.

### Versions and releases
- Versions are two-part, `MAJOR.MINOR`, and roll over after `.9`: `1.0` → `1.1` … `1.9` → `2.0`.
  `package.json` (and `package-lock.json`) hold `MAJOR.MINOR.0` because npm needs three parts.
  `scripts/release-version.sh next` prints the next version.
- **Every release has a GitHub Release** (no files attached is fine). The Release workflow makes
  one automatically when a push to `main` carries a `package.json` version with no `vX.Y` tag yet.
  So, to release: bump the version, add the `CHANGES.md` entry, update `README.md`, push to main.
- **README is rolling:** update `README.md` (including the "Status" section's current version)
  in the same commit as any user-visible change.

### Stay within GitHub's free tier
- Public repo: Actions minutes and public GHCR images are free. Don't add paid features:
  no larger runners, no uploaded build artifacts or release assets (unless asked), no Git LFS,
  no extra Packages beyond the one image. Keep one image name, `ghcr.io/samschultzponsys/dreymail`,
  tags `X.Y` and `latest`. The GHCR package must be public (set once in its package settings).
- Don't add scheduled workflows or matrix builds without asking.

## Architecture

- **Language:** TypeScript end to end (Node.js ≥ 22.13; uses the built-in `node:sqlite`).
- **Server:** Fastify 5 (`server/src`): IMAP via `imapflow`, SMTP/MIME via `nodemailer`,
  OIDC via `openid-client`, HTML sanitizing via `sanitize-html` + `postcss`, Web Push (own VAPID +
  RFC 8291), WebSocket live updates (IMAP IDLE). SQLite: `ratatoskr.db` (users, encrypted
  accounts, prefs, push subs, snoozes) and `cache.db` (encrypted, disposable mail cache).
- **Web client:** React 19 + TanStack Query, built by Vite (`web/`), installable PWA with a
  notification-only service worker (`web/public/sw.js`).
- **Shared:** `shared/` holds types, conversation grouping and the sandboxed iframe builder.
- **Layout:**
  ```
  server/src   app.ts, config.ts, crypto.ts, db.ts, auth/, cache/, imap/, mail/, net/, push/, routes/
  server/test  unit tests (+ fixtures, incl. hostile HTML) and integration/ (GreenMail in Docker)
  web/src      React app; web/public static files, icons, manifest, sw.js; web/test unit tests
  shared/      code used by both
  docker/      entrypoint.sh (drops to PUID:PGID, chowns /data)
  scripts/     dev runner, icon generator, release-version.sh
  branding/    dreymail's icon (night + day SVG, 512px PNG), generated by scripts/icons.mjs
  ```
- Upstream's README sections "Security model" and "Architecture" are the detailed reference.

## Build, test, run

```sh
npm ci
npm run typecheck
npm test                    # unit tests (vitest), ~5 s
npm run test:integration    # needs Docker: GreenMail container + entrypoint image build
npm run build               # dist/server + dist/web
npm start                   # runs the production build
cp .env.example .env && PORT=5173 npm run dev   # local dev only (the .env is for dev, never for deployment)
docker build -t dreymail:dev .
docker run --rm -p 8080:8080 -e RATATOSKR_SECRET_KEY=$(openssl rand -base64 48) -v "$PWD/tmpdata:/data" dreymail:dev
```

In the Claude Code cloud sandbox: start Docker with `dockerd &`. Image builds there can't reach
Alpine's package mirrors through the sandbox proxy, so `apk add` fails unless the proxy CA is
added in a throwaway build. That's a sandbox limitation; GitHub Actions builds normally.

## Owner's deployment conventions (examples must match)

- Docker Compose stacks managed with **Arcane** on **Unraid**. No Unraid Community Apps
  templates.
- **No `.env` files.** Environment goes inline in the compose file as a list (`- KEY=value`).
- Bind mounts under `/mnt/nvme2tbadata/dockerstatic/<container-name>`.
- `PUID=99`, `PGID=100`.
- **No published ports.** Containers join the external network `customnetex` and sit behind
  the owner's reverse proxy.
- Example:
  ```yaml
  services:
    dreymail:
      image: ghcr.io/samschultzponsys/dreymail:latest
      container_name: dreymail
      restart: unless-stopped
      environment:
        - PUID=99
        - PGID=100
      networks:
        - customnetex
      volumes:
        - /mnt/nvme2tbadata/dockerstatic/dreymail:/data

  networks:
    customnetex:
      external: true
  ```
- **Configuration direction (planned, see ROADMAP):** every setting (OIDC, defaults, cache, …)
  must be configurable in the UI and stored in the database. Any value given as an environment
  variable in the compose file **overrides** the UI/database value (and the UI should show it as
  set by the environment). Bootstrap-only exceptions (e.g. the secret key, data dir) stay in env.

## Renames deferred on purpose (don't do these casually)

### Environment variables: rename later, with a backward-compatible fallback
Keep the `RATATOSKR_*` names working. The plan is to accept `DREYMAIL_*` first and fall back to
`RATATOSKR_*`.
`RATATOSKR_BASE_URL`, `RATATOSKR_SECRET_KEY`, `RATATOSKR_TRUST_PROXY`, `RATATOSKR_DATA_DIR`,
`RATATOSKR_WEB_DIR`, `RATATOSKR_PASSWORD_LOGIN`, `RATATOSKR_REGISTRATION`,
`RATATOSKR_BLOCK_PRIVATE_MAIL_HOSTS`, `RATATOSKR_IMAP_IDLE_TIMEOUT`, `RATATOSKR_MAX_MESSAGE_MB`,
`RATATOSKR_MAX_UPLOAD_MB`, `RATATOSKR_CACHE`, `RATATOSKR_CACHE_MESSAGES`,
`RATATOSKR_CACHE_MAX_BODY_MB`, `RATATOSKR_CACHE_ACCOUNT_MB`, `RATATOSKR_VAPID_SUBJECT`,
`RATATOSKR_DEFAULT_IMAP_HOST`, `RATATOSKR_DEFAULT_IMAP_SECURITY`, `RATATOSKR_DEFAULT_IMAP_PORT`,
`RATATOSKR_DEFAULT_SMTP_HOST`, `RATATOSKR_DEFAULT_SMTP_SECURITY`, `RATATOSKR_DEFAULT_SMTP_PORT`,
`RATATOSKR_DEFAULT_MAIL_USERNAME`, `RATATOSKR_DEFAULT_EMAIL`, `RATATOSKR_DEFAULT_DISPLAY_NAME`,
`RATATOSKR_DEFAULT_ACCOUNT_LABEL`, `RATATOSKR_DEFAULT_MAIL_PASSWORD`, `RATATOSKR_DEV_LOGIN`,
`RATATOSKR_DEV_ALLOWED_HOST_SUFFIX`. (`OIDC_*`, `PUID`, `PGID`, `UMASK`, `PORT`, `HOST`,
`LOG_LEVEL` are neutral and stay.)

### Internal identifiers and data: future, deliberate migration only
- **`server/src/crypto.ts`: the HKDF salt `'ratatoskr'`.** **Never change it.** Every stored
  account password, session cookie, cache key and push key derives from it, so changing it makes
  existing data unreadable.
- `server/src/cache/store.ts`: HMAC label `'ratatoskr mail cache'`. Changing it invalidates the
  cache (harmless but wasteful).
- Database file `ratatoskr.db` (in `server/src/app.ts`) and `cache.db` in the data volume. A
  rename needs a migration that moves the existing file.
- HTTP header `x-ratatoskr` (CSRF guard, in `web/src/api.ts`, `web/public/sw.js`,
  `server/src/routes/api.ts`, `server/src/auth/routes.ts`). Client and server must change
  together, and old installed service workers would still send the old header.
- localStorage key `ratatoskr.pendingMailto` (`web/src/mailto.ts`).
- Outgoing identifiers: `X-Mailer: Ratatoskr` (`server/src/mail/compose.ts`), IMAP client ID
  `Ratatoskr` (`server/src/imap/connect.ts`), image-fetcher User-Agent
  (`server/src/net/remoteImages.ts`).
- Container entrypoint path `/usr/local/bin/ratatoskr-entrypoint` and its log prefix
  (`Dockerfile`, `docker/entrypoint.sh`, integration test).
- Code comments, test names, the vite dev plugin name, the CSS header comment.
- The running-squirrel phone animation (`web/src/assets/squirrel-running.svg`, `squirrel.ts`,
  `SquirrelRun.tsx`) is upstream art, kept and tinted cyan.

## Brand
- Icon: cyan envelope (`#22d3ee`) in an indigo drey (`#3b47a8`, weave `#6c7bd9`) on night navy
  (`#141b34`); day tile `#e8ecff`. All variants come from `scripts/icons.mjs` (run it after any
  icon change: `npm i --no-save @resvg/resvg-js && node scripts/icons.mjs`).
- The accent colour in `web/src/styles.css` is the envelope cyan: `--accent-fill: #22d3ee` with navy
  `--accent-text: #141b34`. Text accent is `#0e7490` in light and `#67e8f9` in dark. The owner dislikes
  brown, so avoid brown or orange-brown shades.

## Pulling upstream fixes

```sh
git fetch upstream
git merge upstream/main          # or: git cherry-pick <sha>
```
Resolve conflicts keeping our changes **and** all notices (both upstream's and our "Modified by"
lines). Run the full test suite, then record the merge in `CHANGES.md` with the upstream commit
hash.
