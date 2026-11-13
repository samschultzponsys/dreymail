# Changes from upstream

dreymail is a modified version of [Ratatoskr](https://github.com/magnuspihl/Ratatoskr) by Magnus
Pihl, licensed AGPL-3.0-only. This file is the dated record of our modifications, as AGPL-3.0
§5(a) requires. Every change to upstream material gets an entry here, newest first.

**Starting point:** upstream `main` at
[`e2abaa4c585a2e0edc8a09b082208941c32afcdc`](https://github.com/magnuspihl/Ratatoskr/commit/e2abaa4c585a2e0edc8a09b082208941c32afcdc)
(2026-10-27, "Merge pull request #29 … the cache miss is still happening sometimes"). The full
upstream history is kept in this repository.

Upstream merges are recorded here too, with the upstream commit they brought in.

---

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
