# CLAUDE.md: working on DreyMail

DreyMail (pronounced "DRAY-mail"; a drey is a squirrel's nest) is a self-hosted webmail portal. It
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
  // Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
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
- **Generated files** (icons from `scripts/icons.mjs`) get their notice from the generator; never
  hand-edit them.
- **Before every push, audit the notices.** Every file changed since upstream must carry a
  notice; JSON and PNG files are covered by `CHANGES.md` instead:
  ```sh
  for f in $(git diff --name-only --diff-filter=AM e2abaa4 -- .); do case "$f" in *.png|*.json|*.webmanifest) ;; *) grep -q "samschultzponsys\|GNU AGPL\|AGPL-3.0" "$f" || echo "MISSING notice: $f";; esac; done
  git diff --quiet e2abaa4 -- LICENSE || echo "LICENSE CHANGED: revert it"
  ```
- **Update `CHANGES.md`** with every change: a dated entry with the version, listing what changed
  and in which files.
- **Network-use source offer (AGPL §13):** if anyone other than the owner ever uses a deployed
  instance, the UI **must** link to this project's source code (the repo URL, at the exact
  version running). It's not built yet; it's on `ROADMAP.md` and must ship before the instance is
  shared.
- `NOTICE` carries an AGPL §7(b) additional term: anyone redistributing or hosting DreyMail
  keeps the NOTICE attribution (DreyMail + Ratatoskr) and the in-UI attribution/source link intact.

### Git
- **Never push to `upstream`.** Its push URL is set to `DISABLED`; leave it that way.
- Push to `origin main` without asking (owner's standing instruction). Commit in logical steps.
- Don't push upstream's tags (e.g. `v0.1.0`); DreyMail has its own version line. Push branches by
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
  no larger runners, no uploaded build artifacts, no Git LFS. Release assets are only the desktop
  apps (owner asked; free on GitHub),
  no extra Packages beyond the one image. Keep one image name, `ghcr.io/samschultzponsys/dreymail`,
  tags `X.Y` and `latest`. The GHCR package must be public (set once in its package settings).
- Don't add scheduled workflows or matrix builds without asking.

## Architecture

- **Language:** TypeScript end to end (Node.js ≥ 22.13; uses the built-in `node:sqlite`).
- **Server:** Fastify 5 (`server/src`): IMAP via `imapflow`, SMTP/MIME via `nodemailer`,
  OIDC via `openid-client`, HTML sanitizing via `sanitize-html` + `postcss`, Web Push (own VAPID +
  RFC 8291), WebSocket live updates (IMAP IDLE). SQLite: `dreymail.db` (users, encrypted
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
  desktop/     Electron desktop app (own package.json; main.cjs, preload.cjs, update.cjs, setup.html,
               electron-builder.yml). Built in CI into deb/rpm/flatpak/exe on each release.
  branding/    DreyMail's icon (night + day SVG, 512px PNG), generated by scripts/icons.mjs
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
docker run --rm -p 8080:8080 -e DREYMAIL_SECRET_KEY=$(openssl rand -base64 48) -v "$PWD/tmpdata:/data" dreymail:dev
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

## Identity (DreyMail's own names, since 1.5)

DreyMail has its own identity throughout: `DREYMAIL_*` environment variables, `dreymail.db`,
`x-dreymail` CSRF header, `dm_session` cookie, `dreymail-entrypoint`, `X-Mailer: DreyMail`.
**Never reintroduce the upstream project's name** in code, env, comments or UI. The only allowed
mentions are the legally required attribution (NOTICE, README Credits, file-header notices,
CHANGES.md history) and `server/src/upgrade.ts`.

- `server/src/upgrade.ts` carries data written before 1.5 over (old database file name, old
  key-derivation salt, old env prefix → refuses to start and says what to rename). Delete it once
  the owner confirms every instance has started on 1.5+.
- **Never change the HKDF salt `'dreymail'`** in `server/src/crypto.ts`: every stored account
  password, session cookie, cache key and push key derives from it.
- The running-squirrel phone animation (`web/src/assets/squirrel-running.svg`, `squirrel.ts`,
  `SquirrelRun.tsx`) is upstream art, kept and tinted to the accent colour.

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
