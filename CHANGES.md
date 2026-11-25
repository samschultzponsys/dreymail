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

## 2026-11-25 (v14.4): starts faster

Measured with `node scripts/bench/speed.mjs … --suite startup` (renamed from `open.mjs`; the built
web app in Chromium, two mailboxes, from opening DreyMail to the mail list; a desktop on the LAN,
and a phone on 4G: 120 ms more per request, 12 Mbit/s, a 4× slower processor; 5 runs).
Milliseconds, median / slowest:

| Until the mail list shows | 14.3 | 14.4 |
|---|---:|---:|
| Phone on 4G, first visit | 1749 / 1826 | 948 / 1003 |
| Phone on 4G, next start | 855 / 875 | 513 / 549 |
| Desktop on the LAN, first visit | 207 / 221 (loading screen up to 560) | 171 / 197 |
| Desktop on the LAN, next start | 120 / 131 | 101 / 112 |
| Downloaded on a first visit | 946 KB | 287 KB |

- **Compressed at build:** the web app is compressed once when it is built (brotli and gzip,
  `scripts/compress-web.mjs`), and the server sends the compressed files (910 KB → 230 KB).
- **Cached for good:** files whose name carries their content's hash (everything under `assets/`)
  are kept by the browser instead of being checked with the server on every start. Pages are
  always checked (`no-cache`; they were `max-age=0`).
- **Split:** Settings, Accounts, the AI assistant, Calendar, Contacts, Tasks and the composer are
  separate files loaded when first opened, and fetched in the background once the app is idle, so
  opening them stays instant (the start's script: 816 KB → 489 KB). After an update, a file of
  the old version that is gone makes the page start again once.
- **The first requests start at once:** the app remembers which data it asked for in its first
  seconds on each page (addresses only, never any mail; in this browser), and a small script in
  the page asks for the same again on the next start while the app's script is still
  downloading, what the mail list needs first. The app takes those answers instead of asking one
  after another. Without anything remembered (a new device) it still asks for who you are, your
  mailboxes and groups together. The script is allowed by its hash in the page's
  Content-Security-Policy; any other inline script stays blocked.
- **The loading screen doesn't wait for the folder list;** the sidebar's folders and counts
  follow a moment later.
- **Files:** `web/index.html`, `web/src/api.ts`, `web/src/App.tsx`, `web/src/lazyPart.ts` (new),
  `web/src/settingTabs.ts` (new), `web/src/components/SettingsDialog.tsx`,
  `web/test/bootPreload.test.ts` (new), `server/src/app.ts`, `server/test/spa.test.ts`,
  `scripts/compress-web.mjs` (new), `scripts/bench/speed.mjs` (was `open.mjs`), `README.md`,
  `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-25 (v14.3): folders list at once

Measured with `node scripts/bench/open.mjs … --suite list` (a mailbox of 300 conversations, 120
replies in Sent, 250 in Archive, and a second mailbox; GreenMail behind a simulated Office 365 link,
80 ms round trip, 50 Mbit/s; 5 runs). Milliseconds, median / slowest:

| Listing | 13.9 | 14.2 | 14.3 |
|---|---:|---:|---:|
| Inbox, its next pages, All inboxes, unread only | 5–7 | 5–7 | 5–7 |
| Sent | 382 / 390 | 378 / 381 | 5 / 10 |
| Archive (any other folder) | 406 / 408 | 406 / 1964 | 6 / 9 |
| The same folder again right away | 406 / 407 | 406 / 408 | 4 / 7 |
| A folder never opened before | 1591 / 3411 | 1563 / 3387 | 659 / 667 |
| That folder 1 s later | 406 / 1926 | 406 / 407 | 6 / 10 |
| Refresh button (checks with the mail server first) | 406 | 406 | 406 |

- **Folders other than the inbox are listed from the copy at once.** Each listing used to wait up
  to 0.4 s for a check with the mail server. The check now runs in the background, and the list
  updates by itself when it finds changes made by other mail clients. A folder where DreyMail itself
  just moved or sent mail, and an inbox not being watched, still wait for the check.
- **No more once-a-minute stall:** which folder is Sent or Drafts came from a folder list that,
  once a minute, had to be fetched again before a folder could be listed (seconds on a big
  mailbox; the slowest runs above). An older list is now used while a fresh one is fetched.
- **A folder never opened before** isn't searched on the mail server for older messages of its
  conversations; its copy is ready a moment later, the browser is told, and the list comes again
  from it with whole conversations.
- **Fix:** a sync still under way when a mailbox was removed could write some of its mail back
  into the cache.
- **Tests:** two integration tests now check that another client's changes to a folder reach its
  list after the check, instead of on the very first listing.
- **Files:** `server/src/imap/mail.ts`, `server/src/imap/pool.ts`, `server/src/cache/sync.ts`,
  `server/test/integration/cache.test.ts`, `server/test/integration/mail.test.ts`,
  `server/test/integration/threads.test.ts`, `scripts/bench/open.mjs`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-25 (v14.2): measured speed-ups

Every change below was measured with the new benchmark (`scripts/bench/open.mjs`): 13.9 against
14.2, each on a fresh mailbox of 300 messages (notes, newsletters, photo mail) on GreenMail behind
a simulated Office 365 link (80 ms round trip, 50 Mbit/s), 5–7 runs each. Milliseconds, median /
slowest:

| Measurement | 13.9 | 14.2 |
|---|---:|---:|
| 1 new message: arrival → open | 1352 / 1549 | 707 / 1541 |
| 8 new messages at once: arrival → open | 1028 / 1776 | 1029 / 1076 |
| 1 new photo message (2 × 4 MB): arrival → open | 3330 / 3442 | 2908 / 2940 |
| open a message whose content isn't kept | 260 / 270 | 177 / 191 |
| the same, while a sync is running | 861 / 884 | 175 / 193 |
| conversation of 4, none kept: all open | 1136 / 1159 | 325 / 344 |
| photo message: open | 2221 / 2235 | 234 / 251 |
| photo message: each picture | ~2240 | ~65 |
| photo message too new to be kept: each picture | ~2235 | ~56 |

Opening a photo message whose content isn't kept yet still takes as long as downloading it
(about 2.2 s for 11 MB at 50 Mbit/s); everything after that is from memory.

- **New mail's content is fetched at once**, on the connection for reading, alongside the sync
  that lists it, newest first, a few at a time. Every message is claimed at the start, so loading
  ahead never downloads one a second time. (Fetching it after the sync was measured too: a burst
  sometimes took 2.5 s to open.)
- **A conversation opens in one request to the mail server:** messages of one folder asked for
  while a fetch is under way go together in the next IMAP command (at most 25, and 64 MB).
- **Remote images are found in a light pass** instead of a whole second sanitizing of the
  message (3–4× quicker: 8.6 → 2.3 ms for a typical newsletter, 45 → 16 ms for a very long one).
  It follows the sanitizer's rules exactly; a test compares both on 20,000 generated messages and
  the hostile fixtures.
- **Messages up to 50 MB are kept** (`DREYMAIL_CACHE_MAX_BODY_MB`, was 25 in 14.1): the largest
  message DreyMail shows, so the biggest photo mail (a 25 MB attachment is about 34 MB as mail)
  is kept too.
- **Unread mail loaded ahead a few messages per command** (it was one round trip per message);
  every background download is capped by size.
- **Cleanup:** removed unused code (`addMonths`, `ADMIN_PERMISSIONS`, `useMessageCache`,
  `knownAddresses`).
- **Benchmark:** `node scripts/bench/open.mjs old=<app.js> new=<app.js>` (see README, Development).
- **Files:** `server/src/cache/sync.ts`, `server/src/cache/store.ts`, `server/src/imap/mail.ts`,
  `server/src/mail/sanitize.ts`, `server/src/config.ts`, `server/src/db.ts`,
  `server/src/calendar/adminReminders.ts`, `shared/permissions.ts`, `web/src/hooks.ts`,
  `server/test/remoteUrls.test.ts` (new), `server/test/autoImages.test.ts`,
  `server/test/cache.test.ts`, `server/test/integration/cache.test.ts`,
  `scripts/bench/open.mjs` (new), `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-25 (v14.1): pictures and attachments open at once

- **Opening a picture no longer downloads the whole message again.** Messages larger than the
  cache kept (1 MB, so most mail with photos) were downloaded from the mail server and decoded
  whole for every attachment opened, and again for each picture in the viewer. The last messages
  opened are now kept decoded in memory (up to 512 MB for the server, 10 minutes, each only for its user), so their pictures and
  attachments, and replies and forwards, come from memory. Asking again for pictures still
  loading no longer downloads the message again either: only its flags are checked.
- **Messages up to 25 MB are kept** (`DREYMAIL_CACHE_MAX_BODY_MB`, was 1 MB), so mail with photos
  opens from the copy too, also after a restart. Space per user is unchanged; the oldest content
  gives way first.
- **Background reads in bounded batches.** Filling the copy and the search index fetch at most
  32 MB per IMAP command (one larger message alone); messages too big to keep are only read for
  their start (288 KB) to index them.
- **The viewer fetches ahead:** the next and previous pictures load while you look at one.
- **Decoding on worker threads:** messages over 256 KB being opened are decoded on two worker
  threads of their own, so the server stays free for other requests meanwhile.
- **Files:** `server/src/mail/openedMemo.ts` (new), `server/src/imap/mail.ts`,
  `server/src/cache/sync.ts`, `server/src/cache/store.ts`, `server/src/cache/textPool.ts`,
  `server/src/cache/textWorker.ts`, `server/src/config.ts`, `server/src/app.ts`,
  `server/test/openedMemo.test.ts` (new), `server/test/cache.test.ts`,
  `server/test/integration/cache.test.ts`, `web/src/components/ImageViewer.tsx`, `README.md`,
  `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-25 (v14.0): messages open faster

- **New mail is listed sooner.** A sync used to download the content of up to 30 new messages
  before the list heard about them, holding the main mail-server connection the whole time. Now the
  list updates first, and the content follows right after in batches of 5, newest first.
- **Opening new mail joins the download.** Opening a message whose content is being downloaded
  right then waits for that download instead of fetching the message a second time.
- **A connection only for opening messages.** A message whose content isn't kept yet is fetched on
  its own connection, so it never waits behind a sync, an action (marking read, moving) or a
  folder list. When the cache already knows its size, it takes one round trip instead of two.
- **Messages fetched ahead.** When a message opens, the two below it and the one above it are
  fetched into the cache in the background (`POST /api/messages/warm`), and so is a row the mouse
  rests on for a moment, so j / k, archive, delete and clicks find them ready.
- **Image permission check without reading the whole address book.** Deciding whether to load a
  message's images for a known sender looked up only that sender's address instead of reading
  every remembered address and contact on each open.
- **Files:** `server/src/imap/pool.ts`, `server/src/imap/mail.ts`, `server/src/cache/sync.ts`,
  `server/src/routes/api.ts`, `server/src/db.ts`, `server/src/mail/imageAllowlist.ts`,
  `server/test/autoImages.test.ts`, `server/test/integration/cache.test.ts`, `web/src/api.ts`,
  `web/src/App.tsx`, `web/src/warm.ts` (new), `web/src/components/MessageList.tsx`,
  `web/src/components/SwipeRow.tsx`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-24 (v13.9): new mail opens at once

- **New messages open at once.** When the cache sees new messages in any folder (the inbox,
  Sent Items with the reply you just sent, any other folder), it fetches their content in the same
  step, up to the 30 newest. Before, only unread inbox mail was fetched ahead, and everything else
  waited for the background indexer, so opening a message that had just arrived could still wait
  for the mail server (slow with Outlook).
- **Files:** `server/src/cache/sync.ts`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-24 (v13.8): loading screen; noticing updates

- **Loading screen.** DreyMail shows its icon and a progress bar the moment it opens, until there
  is something to show (the sign-in page, or your mail list), instead of a blank or black window
  followed by an empty mailbox. After 4 seconds it says the server may be starting up; it never
  stays longer than 10 seconds. The desktop app shows the same screen while it connects to the
  server, instead of a black window.
- **Server updates are noticed without restarting.** The live connection's greeting now carries
  the server's version, so a reconnect after an update is noticed at once; the version is also
  checked every 5 minutes and when the window gets focus.
- **Update banners.** A page older than the server shows "Reload" and reloads by itself when you
  come back to it (or while it's in the background), unless you're writing a message. A desktop or
  Android app older than the server shows a banner with "Update the app". Administrators see a
  note when the server is older than the app. "Not now" hides a banner for the session.
- **Files:** `server/src/routes/ws.ts`, `shared/types.ts`, `web/index.html`, `web/src/App.tsx`,
  `web/src/hooks.ts`, `web/src/splash.ts` (new), `web/src/components/VersionBanner.tsx` (new),
  `web/src/components/Sidebar.tsx`, `web/src/styles.css`, `desktop/main.cjs`,
  `desktop/loading.html` (new), `desktop/electron-builder.yml`, `server/test/devHosts.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-24 (v13.7): Settings uses the window

- **Settings** uses most of the window (up to 1100 px wide, the full height), scaling with it
  like the other big dialogs, and its tabs wrap onto another line instead of being cut off (also
  on phones, where they used to scroll sideways out of sight).
- **Files:** `web/src/components/SettingsDialog.tsx`, `web/src/styles.css`, `README.md`,
  `package.json`, `package-lock.json`.

## 2026-11-24 (v13.6): opening mail and lists from the copy

- **Opening a message without the mail server:** filling the search index already downloaded
  most of each message and threw it away; it now downloads each whole message (up to
  `DREYMAIL_CACHE_MAX_BODY_MB`) and keeps it as its content, so opening it is answered from the
  copy. Messages indexed before 13.6 get theirs afterwards, newest first, while the mailbox has
  room. When space runs short, the oldest mail's content goes first (each counts as last read
  when it arrived), not the newest's.
- **No more stalls while indexing:** the space each mailbox uses (which counts the whole word
  index) was measured several times a second; it is now remembered for 20 seconds.
- **Lists show sooner:** a folder's list waits at most 0.4 s (was 1.5 s) for the check with the
  mail server; what a slower check finds reaches the list by itself.
- **Files:** `server/src/cache/sync.ts`, `server/src/cache/store.ts`,
  `server/test/searchIndex.test.ts`, `server/test/integration/cache.test.ts`, `README.md`,
  `package.json`, `package-lock.json`.

## 2026-11-24 (v13.5): Outlook invitations keep their line breaks

- **Fix:** an Outlook event's message to guests was sent to Microsoft as plain text; on the way
  (Exchange, server-side signature tools) it lost its line breaks and arrived as one long line.
  It is now sent as HTML: line breaks kept, web addresses as links, everything else escaped.
- **Fix:** the one-time code button picked a number out of a longer run of digit groups (a Zoom
  meeting ID, "730 9908 7625"); such numbers are skipped, so the real passcode is found instead.
- **Files:** `server/src/calendar/remote.ts`, `shared/codes.ts`, `server/test/conveniences.test.ts`,
  `README.md`, `package.json`, `package-lock.json`.

## 2026-11-24 (v13.4): "Last, First" names; quoted mail in the dark composer

- **Fix:** recipients whose name is in quotes with a comma (Outlook's "Estomo, Toni" <…>) were
  split at the comma into two bubbles, shown red as invalid (`"Estomo` and `Toni`). The To, Cc and
  Bcc fields now ignore commas inside quotes and <…>, and such names count as valid. Sending was
  never affected (the server parses addresses properly), but removing or editing such a bubble
  could break the line.
- **The quoted message in the composer** shows on a white sheet in dark mode, like the reader's
  Paper view, so its own colors (dark text, colored signatures, logos) stay readable. What is
  sent is unchanged.
- **Files:** `web/src/addresses.ts`, `web/src/styles.css`, `web/test/addresses.test.ts`,
  `README.md`, `package.json`, `package-lock.json`.

## 2026-11-24 (v13.3): messages show without waiting for their pictures; a message to guests

- **Faster opening of picture-heavy mail:** a message with images to load waited up to 5 s for
  the server to fetch them (and pictures not started by then were never fetched). Now it shows
  after at most 0.6 s with the pictures already here; the rest keep downloading on the server (8
  at a time, up to 30 s) and the app asks again (`imagesPending`) every 1.2 s, a few times, so they
  fill in.
- **Events with guests:** the Notes box becomes "Message to guests" (bigger, with a hint): it is
  what guests see in the invitation (Outlook and Google put it in the event; DreyMail and CalDAV
  invitations carry it in the email and the event).
- **Files:** `server/src/net/remoteImages.ts`, `server/src/imap/mail.ts`, `shared/types.ts`,
  `web/src/components/Reader.tsx`, `web/src/components/EventEditor.tsx`,
  `server/test/remoteImages.test.ts`, `README.md`, `package.json`, `package-lock.json`.

## 2026-11-24 (v13.2): conversations newest first; bigger message buttons on phones

- **Conversations** show their newest message at the top; scroll down to go back in time.
  Settings → General → Conversations switches back to oldest first (preference `threadOrder`).
- **Each message's buttons on phones:** large icons on tinted accent buttons, the first (Reply by
  default) filled, all in one row.
- **Files:** `shared/types.ts`, `server/src/routes/api.ts`, `web/src/components/Reader.tsx`,
  `web/src/components/SettingsDialog.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `README.md`,
  `package.json`, `package-lock.json`.

## 2026-11-24 (v13.1): phones: a clear Back button, toolbars in one row

- **Reader toolbar on phones:** Back is a filled accent button that stays at the left; the other
  buttons stay in one row that scrolls sideways (a fade at the edge shows there are more) instead
  of running off the screen.
- **Each message's buttons on phones:** large icons sharing one row (names hidden), instead of
  wrapping onto two rows.
- **Files:** `web/src/components/Reader.tsx`, `web/src/styles.css`, `README.md`, `package.json`,
  `package-lock.json`.

## 2026-11-23 (v13.0): indexing in parallel, out of the app's way

- **Fix:** filling the search index read and parsed messages (MIME, HTML) on the server's one
  JavaScript thread, so while it worked through a big mailbox everything else (opening a
  composer, sending, lists) waited. Messages are now read in worker threads (every CPU thread
  the server has but one: at least two, at most eight), 80 fetched at a time; the server's own thread only files
  their words. Between rounds, requests of people using DreyMail go first.
- **Files:** `server/src/cache/textWorker.ts` (new), `server/src/cache/textPool.ts` (new),
  `server/src/cache/sync.ts`, `server/src/cache/store.ts`, `server/src/app.ts`, `README.md`,
  `package.json`, `package-lock.json`.

## 2026-11-23 (v12.9): each message's buttons, your way

- **Settings → General → Buttons on each message:** tick the buttons (Reply, Reply all, Forward,
  Mark read/unread, Flag, Archive, Delete), put them in any order (arrows), and choose where:
  a bar at the top of the message that stays in view while it scrolls (the new default; small,
  medium or large, with or without names) or the small icons beside the date as before. New
  preference `messageButtonStyle`; the order of `messageButtons` is now kept.
- **Files:** `shared/types.ts`, `server/src/routes/api.ts`, `web/src/components/Reader.tsx`,
  `web/src/components/SettingsDialog.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `README.md`,
  `package.json`, `package-lock.json`.

## 2026-11-23 (v12.8): instant search results; more space

- **Quick results:** every word search (no other filters) first asks the search index alone
  (`quick=1`), which answers at once from whatever DreyMail's copy holds, newest mail first; the
  list shows that with "Found on this server so far; still searching all your mail…" until the
  full search (which asks the mail servers for anything not in the copy) has its first page.
- **Fix: a search slowing everything else down.** A whole-mailbox search used the mailbox's main
  connection as one of its four, so opening a message (or another folder) waited behind it, even
  after leaving the search. Searches now use four connections of their own, and a search the
  browser has left (another folder opened, the box cleared) stops after the folders under way.
- **More space by default:** 4096 MB per user (was 1024), 10000 messages of other folders (was
  5000); the index fills twice as fast (50 messages a round).
- **Files:** `server/src/imap/mail.ts`, `server/src/routes/api.ts`, `server/src/cache/sync.ts`,
  `server/src/cacheBudget.ts`, `server/src/config.ts`, `server/src/imap/pool.ts`, `shared/types.ts`,
  `shared/serverSettings.ts`, `web/src/api.ts`, `web/src/hooks.ts`, `web/src/App.tsx`,
  `web/src/components/MessageList.tsx`, `web/src/styles.css`, `server/test/searchIndex.test.ts`,
  `server/test/cache.test.ts`, `README.md`, `package.json`, `package-lock.json`.

## 2026-11-23 (v12.7): the search index actually used for whole-mailbox searches

- **Fix:** before answering a folder from the search index, 12.3 synced every searched folder
  (giving each 1.5 s, all on one connection), so a search of a whole mailbox's many folders almost
  never used the index. Now one folder list with STATUS per mailbox (newest UID and message count,
  now asked for too) is compared with the copy: unchanged folders are answered from the index at
  once; changed ones are searched on the server this time and synced in the background.
- **Settings → Search and storage** shows, per mailbox, how many folders are searched instantly
  (all copied and indexed), and says when a mailbox's share is full.
- **Files:** `server/src/imap/mail.ts`, `server/src/imap/pool.ts`, `server/src/cache/store.ts`,
  `server/src/app.ts`, `web/src/components/CacheSettings.tsx`, `server/test/searchIndex.test.ts`,
  `README.md`, `package.json`, `package-lock.json`.

## 2026-11-23 (v12.6): searching a whole mailbox without timeouts

- **Fix:** a search of a whole mailbox (or all mail) queued every folder's search on the mailbox's
  one connection at once, so with many folders on a slow server the later ones gave up ("Timed out
  waiting for mailbox lock"). Folders are now searched a few at a time, each on a connection of its
  own (up to four per mailbox), and up to 150 folders per mailbox are searched (was 40).
- **Errors** of a search of many folders show as one line per mailbox (how many folders, a few
  named, the reason) with Try again, instead of a banner per folder.
- **Files:** `server/src/imap/mail.ts`, `server/src/imap/pool.ts`, `shared/types.ts`,
  `web/src/components/MessageList.tsx`, `server/test/integration/mail.test.ts`,
  `web/test/search12.test.ts`, `README.md`, `package.json`, `package-lock.json`.

## 2026-11-23 (v12.5): Microsoft 365 group calendars

- **Group calendars:** an Outlook mailbox's calendar list offers "Calendars of your Microsoft 365
  groups? Allow", which signs in again asking for `Group.ReadWrite.All` (an administrator usually
  approves it once for the organization). Then the calendars of the Microsoft 365 groups you are in
  show under the mailbox, under "Groups" (hidden at first, like in Outlook), and their events can
  be read, created, changed and deleted (`/groups/{id}/calendar`). A refusal is remembered for two
  minutes; signing in again checks at once.
- **Files:** `server/src/calendar/remote.ts`, `server/src/calendar/service.ts`,
  `server/src/oauth/microsoft.ts`, `server/src/routes/microsoft.ts`, `server/src/routes/calendar.ts`,
  `server/src/app.ts`, `shared/calendar.ts`, `web/src/components/CalendarDialog.tsx`,
  `web/src/styles.css`, `server/test/calendar-sync.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-23 (v12.4): calendar nicknames and mailbox colors

- **A name of your own for any calendar** (the pencil → Name in DreyMail): shown everywhere in
  DreyMail; the provider's name stays there and shows when you point at it. Empty: the provider's.
- **Colors:** a mailbox's calendars show in the mailbox's color and follow it when it changes,
  unless you pick another color for one ("<mailbox>'s color" brings it back). Your own calendars
  keep their colors. New columns `calendars.nickname` and `color_set` (migration at the end).
- **Event editor:** the calendar list is grouped by mailbox (My calendars, each mailbox, Shared
  with you), with the chosen calendar's color beside it.
- **Files:** `server/src/db.ts`, `server/src/routes/calendar.ts`, `shared/calendar.ts`,
  `web/src/components/CalendarDialog.tsx`, `web/src/components/EventEditor.tsx`,
  `web/src/styles.css`, `server/test/calendar-sync.test.ts`, `server/test/migrations.test.ts`,
  `web/test/calendarGroups.test.ts`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-23 (v12.3): a search index in the mail cache; space per user

- **Search index:** the mail cache indexes every cached message's words, as keyed hashes per
  mailbox (8 bytes each; no words stored): headers when a message is cached, its content (at most
  96 KB of it, read in the background on the background connection, never marking it read) after.
  A word search (with or without "unread only") of a folder whose copy holds all its mail and is
  all indexed is answered from the index without asking the mail server; other folders, and
  searches with other filters, still go to the mail server. Like a listing, such a search first
  brings the folder's copy up to date (mail that just arrived or moved is found; a message not
  indexed yet sends the search to the mail server). Words are lowercased, without
  accents, with simple English endings taken off. The cache format changes (version 3), so the
  copy is filled again after updating.
- **Space per user:** new server setting `DREYMAIL_CACHE_USER_MB` (1024 by default) for each
  user's copy, index and stored messages, split across their mailboxes evenly (default) or by the
  shares they choose; it replaces `DREYMAIL_CACHE_ACCOUNT_MB`. Stored content gives way first;
  the index stops growing when a mailbox's share is full. Bigger copies by default: 20000
  messages of Inbox and Sent, 5000 of other folders.
- **Settings → Search and storage:** the space used of the allowance, each mailbox's space, message
  count and how far it is indexed (live), and the split (evenly / by my choice, with percents).
- **Files:** `server/src/cache/searchTerms.ts`, `server/src/cache/store.ts`,
  `server/src/cache/sync.ts`, `server/src/cacheBudget.ts`, `server/src/imap/mail.ts`,
  `server/src/app.ts`, `server/src/config.ts`, `server/src/routes/api.ts`, `shared/types.ts`,
  `shared/serverSettings.ts`, `web/src/components/CacheSettings.tsx`,
  `web/src/components/SettingsDialog.tsx`, `web/src/globalSearch.ts`, `web/src/styles.css`,
  `server/test/searchIndex.test.ts`, `server/test/cache.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-23 (v12.2): which mailbox each result is from

- **Lists of several mailboxes** (All inboxes, searching every mailbox, or any list that holds
  mail of more than one mailbox) show each row's mailbox: a full-height bar and a faint tint in
  its color, and a small tag with its icon and name before the subject. Before, only the All
  inboxes view showed a thin bar, and not at all when "All inboxes" was turned off.
- **Titles:** a search of every mailbox reads "All mailboxes"; of one whole mailbox, "<name> ·
  all folders".
- **Files:** `web/src/components/MessageList.tsx`, `web/src/components/SwipeRow.tsx`,
  `web/src/App.tsx`, `web/src/styles.css`, `README.md`, `package.json`, `package-lock.json`.

## 2026-11-22 (v12.1): search everywhere; folders pinned to the top; fewer blocked images

- **Search everywhere:** a box under Contacts and Tasks searches all mail in every mailbox; icons
  at its end switch on searching contacts, tasks, the calendar (half a year back, seven months
  ahead) and settings too (remembered on the device), with matches listed as you type; picking
  one opens that contact, task (its list, opened), event (its day, opened) or settings tab.
- **A search box per mailbox:** the magnifier on a mailbox's heading opens a box that searches the
  whole mailbox; its pin keeps it shown (per device).
- **Search scope:** the search above the message list searches the whole mailbox by default;
  "Search in: This mailbox / This folder / All mailboxes" (or "All mail / Inboxes only" in the
  unified view) shows under it while typing or searching.
- **Folders pinned to the top bar:** a folder's menu → Pin to the top bar; the bar above the list
  shows them with unread counts (and mailbox colors when from several mailboxes), dragged into
  order with a mouse, or held then dragged on touch screens; × removes one. Saved with the
  account (`topFolders` preference).
- **Inbox tabs** (Personal / Updates / Newsletters) are off by default, and switched off for
  existing accounts (migration); the setting stays.
- **Images:** "people you know" now means people you wrote to, people who wrote to you (address
  book) and your contacts; new option to load images in all mail. Junk never loads images by
  itself.
- **Files:** `shared/search.ts`, `shared/types.ts`, `server/src/db.ts`, `server/src/routes/api.ts`,
  `server/src/mail/imageAllowlist.ts`, `web/src/globalSearch.ts`,
  `web/src/components/SidebarSearch.tsx`, `web/src/components/TopFolderBar.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/components/MessageList.tsx`,
  `web/src/components/SettingsDialog.tsx`, `web/src/components/ContactsPage.tsx`,
  `web/src/components/TasksPage.tsx`, `web/src/components/CalendarDialog.tsx`, `web/src/App.tsx`,
  `web/src/styles.css`, `server/test/migrations.test.ts`, `server/test/autoImages.test.ts`,
  `web/test/search12.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-22 (v12.0): this device's settings, saved on a schedule

- **Settings → Backup → This device:** what a browser, the desktop app or the Android app keeps
  for itself (its local storage: interface size, layout, folder bar, toolbar; the Android app's
  notification icons; the desktop app's tray setting) is saved to the server by hand or every day
  or week (checked while DreyMail is open), under a device name that can be changed. Saved devices
  are listed: restore this device, use another device's settings here (after a reinstall or on a
  new phone), download as a file (a plain GET, so the Android app saves it too), restore from a
  file, or forget one. Who the device is, its schedule and one-off state are left out. Device
  settings are part of the account backup.
- **Server:** new table `device_backups` (migration at the end), `GET/PUT/DELETE
  /api/device-backups/:id`, `GET /api/device-backups`, `GET /api/device-backups/:id/file`.
- **Files:** `server/src/db.ts`, `server/src/backup.ts`, `server/src/routes/backup.ts`,
  `web/src/deviceBackup.ts`, `web/src/components/BackupSettings.tsx`, `web/src/App.tsx`,
  `server/test/backup.test.ts`, `server/test/migrations.test.ts`, `web/test/deviceBackup.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-21 (v11.9): backups

- **Settings → Backup (every user):** Download backup: the user's data (mailboxes with their
  passwords and sign-ins, groups, signatures, preferences and picture, address book, blocked
  senders, saved searches, follow-ups, snoozes, auto-replies, S/MIME keys and certificates,
  contacts, tasks, calendars and their events and CalDAV sources, AI connections, rules and
  history) as one file, gzipped and encrypted with a password of their choosing (scrypt +
  AES-256-GCM). Secrets come out of the server's encryption and are sealed again on restore, so a
  backup restores on another server with another secret key too. Prepared by the server and
  fetched from a one-time link (5 minutes), so the Android app's downloader saves it as well.
  Restore from a file replaces the user's data in one transaction (an id that belongs to another
  user here stops it, changing nothing); scheduled sends and calendar shares are kept. Not in a
  backup: passkeys, sign-in identities, push registrations, scheduled sends, and what DreyMail
  rebuilds by itself.
- **Automatic backups:** a copy of the whole database (`VACUUM INTO`) every day in
  `<data>/backups`, kept `DREYMAIL_BACKUP_DAYS` days (new server setting in Settings → Server →
  Backups; default 7, 0 = off). Users can restore their own data from one; administrators see
  the list and can back up now.
- **Files:** `server/src/backup.ts`, `server/src/routes/backup.ts`, `server/src/app.ts`,
  `shared/serverSettings.ts`, `web/src/components/BackupSettings.tsx`,
  `web/src/components/ServerAdmin.tsx`, `web/src/components/SettingsDialog.tsx`,
  `server/test/backup.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-21 (v11.8): wide messages fit narrow screens

- **Messages wider than the screen** (fixed-width tickets and newsletters on a phone) no longer
  run off the right edge. The viewer first lets the parts that are too wide give way (a too-wide
  table fills the width, other boxes size to their content, every box is capped at the width), so
  text wraps and columns keep their proportions; if the message is still too wide, it is shrunk
  to fit (not below 40%). Less padding around messages on phones. Refits when the screen turns
  or the pane is resized.
- **Files:** `shared/srcdoc.ts`, `web/src/components/MessageFrame.tsx`, `README.md`,
  `package.json`, `package-lock.json`.

## 2026-11-21 (v11.7): HTML sent as plain text shows properly

- **Fix:** some senders (ticket systems, mostly) put a whole HTML page in a part labeled
  text/plain. Previews in the list and in notifications showed its markup (`<!DOCTYPE html …`).
  Such a part is now recognized and read as HTML: previews show its text, and opening the message
  shows it as HTML (sanitized like any other), with a plain-text version for replies. Previews
  already cached update as the cache refreshes.
- **Files:** `server/src/imap/snippet.ts`, `server/src/mail/parse.ts`, `server/test/mime.test.ts`,
  `README.md`, `package.json`, `package-lock.json`.

## 2026-11-19 (v11.6): Android Back stays within the mailbox you are in

- **Back button in the Android app:** it no longer walks the browser history (which could land in
  another mailbox picked earlier from the folder list). The app asks the web app: an open overlay
  closes; a message goes back to its folder; another folder, a search, or the calendar, contacts
  or tasks go to the inbox of the mailbox you are in; at an inbox the app goes to the background.
  Older servers keep the old behavior.
- **Files:** `android/app/src/main/java/io/github/samschultzponsys/dreymail/MainActivity.kt`,
  `web/src/routing.ts`, `web/src/App.tsx`, `web/test/routing.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-19 (v11.5): the icon on each side of Android notifications

- **Android, Settings → This device:** "Icon on the left" (DreyMail's, the mailbox's, the
  group's, the mailbox's color; anything but DreyMail's makes it a conversation) and "Icon on the
  right" (the mailbox's, the group's, the mailbox's color, none) replace 11.4's single switch (an
  earlier "on" carries over as the mailbox's icon). The group's icon falls back to the mailbox's,
  and a mailbox with no icon of its own (a color dot) to the envelope in its color. The web app now
  sends each mailbox's group icon, picture and color to the app.
- **Top of the folder bar:** a mailbox that is only a color dot shows its group's icon.
- **Phones:** no pin buttons over the unread counts in the folder bar; pin from a folder's
  long-press menu.
- **Files:** `android/app/src/main/java/io/github/samschultzponsys/dreymail/Notifier.kt`,
  `android/app/src/main/java/io/github/samschultzponsys/dreymail/Prefs.kt`,
  `android/app/src/main/java/io/github/samschultzponsys/dreymail/MainActivity.kt`,
  `web/src/android.ts`, `web/src/App.tsx`, `web/src/components/SettingsDialog.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/styles.css`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-19 (v11.4): Android: the mailbox's icon on the left of notifications

- **New setting** in the Android app (Settings → This device): "Show the mailbox's icon on
  notifications". With it on, new mail is sent as an Android conversation: each mailbox gets a
  long-lived shortcut whose icon (the mailbox's icon on a tile in its color, its picture, or the
  envelope in its color) shows on the left instead of DreyMail's, the notification uses the
  messaging style (sender, then subject and preview), and Android lists it in the Conversations
  section above other apps. Turning it off removes the shortcuts. Off by default; older apps
  don't show the setting.
- **Files:** `android/app/src/main/java/io/github/samschultzponsys/dreymail/Notifier.kt`,
  `android/app/src/main/java/io/github/samschultzponsys/dreymail/Prefs.kt`,
  `android/app/src/main/java/io/github/samschultzponsys/dreymail/MainActivity.kt`,
  `web/src/android.ts`, `web/src/components/SettingsDialog.tsx`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-18 (v11.3): mark a folder all read; the open mailbox at the top

- **Mark all as read:** right-clicking a folder (long-press on a phone) opens a menu with Mark all
  as read (every unread message in the folder, on the server and in the cache) and Pin / Unpin.
  New route `POST /api/folders/read`.
- **The open mailbox at the top of the folder bar:** its icon (on a tile in its color), name and
  the open folder replace DreyMail's mark, following the selection; All inboxes keeps the mark.
- **Files:** `server/src/imap/mail.ts`, `server/src/routes/api.ts`,
  `web/src/components/Sidebar.tsx`, `web/src/styles.css`, `web/test/sidebar.test.ts`, `README.md`,
  `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-18 (v11.2): no ⌄ line when every folder is pinned

- With every folder of a mailbox pinned there is nothing more to show, so the ⌄ line under the
  pinned folders goes away (and the mailbox shows its pinned list).
- **Files:** `web/src/components/Sidebar.tsx`, `web/test/sidebar.test.ts`, `README.md`,
  `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-18 (v11.1): pinned folders your way; unread out of sight stands out

- **Pinned folders** show as one flat list in the order they were pinned, wherever they sit in the
  folder tree, and can be dragged into another order; a subfolder shows the folder it lives in
  after its name (to tell two "Acme" folders apart).
- **Unread in folded or unpinned folders** shows as a filled, accent-colored bubble (on the folder
  they are folded under, or on the ⌄ line under the pinned folders), separate from the folder's own
  count, and flashes for two minutes when new mail arrives there (a steady ring with reduced motion).
- **Files:** `web/src/folderTree.ts`, `web/src/components/Sidebar.tsx`, `web/src/styles.css`,
  `web/test/folderTree.test.ts`, `web/test/sidebar.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-18 (v11.0): Gmail "Allow" takes effect at once

- **Fix:** allowing contacts, tasks or the directory for a Gmail mailbox (Settings → Allow) kept
  using the permissions known from the mailbox's previous token, so the row stayed at "Allow" and
  contacts and tasks didn't load until the token expired. The permissions granted by the sign-in
  are now kept from its token answer right away.
- **Directory** is no longer offered for personal @gmail.com mailboxes (only Google Workspace has
  a company directory).
- **Files:** `server/src/oauth/google.ts`, `server/src/routes/api.ts`, `server/src/directory.ts`,
  `server/test/google.test.ts`, `README.md`, `package.json`, `package-lock.json`.

## 2026-11-18 (v10.9): Gmail labels in the list; this and following for every calendar

- **Gmail labels in lists:** on Gmail (X-GM-EXT-1) message lists are fetched with X-GM-LABELS
  (also into the mail cache); the list shows a message's other labels as tags.
- **This and following** for Google, Outlook and CalDAV series: the series' repeat is cut before
  the occurrence (until the day before in its zone, or a count), changing only the repeat at
  Google and Outlook (`onlyRepeat`), and a new series starts there with the changes; deleting
  this-and-following only cuts.
- **Files:** `server/src/imap/summary.ts`, `server/src/imap/mail.ts`, `server/src/cache/sync.ts`,
  `server/src/calendar/service.ts`, `server/src/calendar/remote.ts`, `server/src/calendar/ical.ts`,
  `server/src/routes/calendar.ts`, `shared/types.ts`, `web/src/components/MessageList.tsx`,
  `web/src/components/EventEditor.tsx`, `web/src/styles.css`, `server/test/calendar-sync.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-18 (v10.8): proposing a new time

- **As a guest:** *Propose a new time* on an invitation answers Maybe or No with a new time and a
  note: Graph `tentativelyAccept` / `decline` with `proposedNewTime` for Outlook mailboxes, an iTIP
  COUNTER email otherwise.
- **As the organizer:** a COUNTER message offers Accept proposal (moves your DreyMail event and
  emails the update, or moves the Outlook / Google event, which tells the guests) or Decline (an
  iTIP DECLINECOUNTER to that guest).
- **Fix:** invitation emails for DreyMail's own and CalDAV events failed to build their text
  (a date format combining `timeStyle` with `timeZoneName`, which Node refuses).
- **Files:** `server/src/calendar/ical.ts`, `server/src/calendar/service.ts`,
  `server/src/calendar/remote.ts`, `server/src/routes/calendar.ts`, `server/src/mail/send.ts`,
  `web/src/components/InviteCard.tsx`, `web/src/styles.css`, `server/test/calendar-sync.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-18 (v10.7): meeting rooms

- **Rooms:** Microsoft 365 rooms (Graph `places/microsoft.graph.room`, Place.Read.All, allowed per
  mailbox and approved by an administrator) merged with an administrator's list (Settings →
  Server → Meeting rooms, `/api/admin/rooms`). The event editor's *Book a room* shows them with
  free/busy at the meeting's time and invites the chosen one as a resource (Graph type `resource`,
  Google `resource: true`, iCalendar `CUTYPE=ROOM`); guest lists show rooms as Booked / Not
  available.
- **Files:** `server/src/calendar/rooms.ts` (new), `server/src/calendar/remote.ts`,
  `server/src/calendar/ical.ts`, `server/src/routes/calendar.ts`, `server/src/routes/admin.ts`,
  `server/src/routes/microsoft.ts`, `server/src/oauth/microsoft.ts`, `server/src/app.ts`,
  `shared/calendar.ts`, `web/src/components/EventEditor.tsx`, `web/src/components/ServerAdmin.tsx`,
  `web/src/styles.css`, `server/test/rooms.test.ts` (new), `CHANGES.md`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-18 (v10.6): S/MIME signed and encrypted mail

- **Reading:** multipart/signed and opaque signed mail is verified (digest over the exact signed
  bytes, the signature over the signed attributes, the certificate's dates, its chain to Node's
  public roots, its address against the sender); enveloped mail is decrypted with your
  certificates' keys. The reader shows what was found; replies, forwards and invitations see the
  decrypted message.
- **Sending:** the composer signs (SHA-256, detached) and encrypts (AES-256-CBC to every recipient
  and to you) for mailboxes with a certificate; encrypting needs each recipient's certificate,
  which DreyMail keeps from their valid signed mail.
- **Certificates:** .p12 / .pfx import per mailbox (Settings → General); the key is sealed with
  the server's key (`smime_keys`, `smime_certs`: new migration).
- **Dependency:** `node-forge` 1.4.0 (BSD-3-Clause) for PKCS #7 and PKCS #12.
- **Files:** `server/src/mail/smime.ts` (new), `server/src/mail/smimeStore.ts` (new),
  `server/src/imap/mail.ts`, `server/src/mail/send.ts`, `server/src/routes/api.ts`,
  `server/src/app.ts`, `server/src/db.ts`, `shared/types.ts`, `web/src/components/Reader.tsx`,
  `web/src/components/Composer.tsx`, `web/src/components/WritingSettings.tsx`, `web/src/styles.css`,
  `server/test/smime.test.ts` (new), `server/test/migrations.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-18 (v10.5): shared Microsoft 365 mailboxes

- **Shared mailboxes:** an Outlook mailbox signed in with Microsoft can open shared mailboxes
  (Accounts → *Add a shared mailbox…*). Each is a mailbox of its own (`accounts.oauth_parent`, new
  migration) reading IMAP as the shared address with the parent's OAuth token; tokens are stored
  and rotated on the parent; sending goes through Graph from the shared address. Adding checks the
  mailbox opens; removing the parent removes its shared mailboxes. Shared mailboxes don't bring
  the parent's calendars, contacts, tasks or directory a second time.
- **Files:** `server/src/db.ts`, `server/src/routes/api.ts`, `server/src/calendar/service.ts`,
  `server/src/people.ts`, `server/src/directory.ts`, `shared/types.ts`,
  `web/src/components/AccountsDialog.tsx`, `server/test/shared.test.ts` (new),
  `server/test/migrations.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-18 (v10.4): Contacts and Tasks

- **Contacts page** (`/contacts`): DreyMail's own contacts (new `contacts` table) with Outlook
  contacts (Graph `/me/contacts`, Contacts.ReadWrite) and Google Contacts (People API connections,
  contacts scope) where allowed per mailbox; search, add, edit, delete, write to an address. Own
  contacts join address suggestions.
- **Tasks page** (`/tasks`): DreyMail's own lists and tasks (new `task_lists` and `tasks` tables)
  with Microsoft To Do (Graph `/me/todo`, Tasks.ReadWrite) and Google Tasks; add, complete, due
  day, notes, delete, new lists.
- Provider data is read live (cached two minutes) and written straight back; the permissions are
  asked for only with *Allow* on the page. Contacts and Tasks buttons sit under Calendar.
- **Files:** `shared/people.ts` (new), `server/src/people.ts` (new), `server/src/routes/people.ts`
  (new), `web/src/components/ContactsPage.tsx` (new), `web/src/components/TasksPage.tsx` (new),
  `server/src/app.ts`, `server/src/db.ts`, `server/src/routes/api.ts`, `web/src/App.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/routing.ts`, `web/src/styles.css`,
  `server/test/people.test.ts` (new), `server/test/migrations.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-18 (v10.3): the company directory in address suggestions

- **Directory:** address suggestions add people from Microsoft 365 (Graph `/me/people`, People.Read)
  and Google Workspace (People API `searchDirectoryPeople`, directory.readonly) after the usual
  ones, marked *Directory*, at most 1.5 s per lookup and cached for a minute.
- **Extra permissions per mailbox:** Microsoft and Google sign-in can ask for more on request
  (`allow` on the OAuth start: Microsoft `people`, `contacts`, `tasks`; Google `directory`,
  `contacts`, `tasks`), never at the normal sign-in; Settings → General shows *Allow* per mailbox.
- **Files:** `server/src/directory.ts` (new), `server/src/oauth/google.ts`,
  `server/src/oauth/microsoft.ts`, `server/src/routes/google.ts`, `server/src/routes/microsoft.ts`,
  `server/src/routes/api.ts`, `server/src/addressBook.ts`, `server/src/app.ts`, `shared/types.ts`,
  `web/src/components/WritingSettings.tsx`, `web/src/components/AddressField.tsx`, `web/src/api.ts`,
  `web/src/styles.css`, `server/test/directory.test.ts` (new), `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-18 (v10.2): dragging events, show as, scheduling assistant

- **Drag to move:** week and day views move events by dragging (15-minute steps, across days);
  an occurrence of a repeating DreyMail event moves on its own (scope "this"), provider occurrences
  as instances.
- **Show as:** busy, free, tentative, away, working elsewhere on events: a `show_as` column (new
  migration), Graph `showAs`, Google `transparency`, CalDAV `TRANSP` and
  `X-MICROSOFT-CDO-BUSYSTATUS`; free and tentative blocks look lighter.
- **Scheduling assistant:** `POST /api/freebusy` returns your busy times (all visible calendars)
  and guests' through Graph `getSchedule` or Google `freeBusy`; the editor's timeline shows them
  with the meeting's time, a click moves it, and Next free time finds a slot on a weekday 7–20.
- **Files:** `web/src/components/SchedulingAssistant.tsx` (new), `web/src/components/CalendarDialog.tsx`,
  `web/src/components/EventEditor.tsx`, `server/src/calendar/remote.ts`, `server/src/calendar/ical.ts`,
  `server/src/calendar/service.ts`, `server/src/calendar/localEvents.ts`, `server/src/routes/calendar.ts`,
  `server/src/db.ts`, `shared/calendar.ts`, `web/src/styles.css`, `web/test/scheduling.test.ts` (new),
  `server/test/repeats.test.ts`, `server/test/migrations.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-18 (v10.1): follow-up flags with due dates

- **Follow up:** a reading-toolbar menu flags a message with a due date (Today, Tomorrow, This
  week, Next week, a date and time, or none) or marks it complete. Follow-ups are kept by
  Message-ID per mailbox (`followups` table, new migration) and the message is \Flagged on the
  server. Lists and the reader show the due date (red when overdue); unflagging or deleting ends it.
- **Reminders:** due follow-ups come through the reminder engine (`calendar_alerts.message_ref`,
  new column): a notification on every device that opens the message, and the reminder window
  with Complete.
- **Files:** `server/src/mail/followups.ts` (new), `web/src/components/FollowUpMenu.tsx` (new),
  `server/src/calendar/reminders.ts`, `server/src/routes/api.ts`, `server/src/app.ts`,
  `server/src/db.ts`, `shared/types.ts`, `shared/calendar.ts`, `web/src/components/Reader.tsx`,
  `web/src/components/MessageList.tsx`, `web/src/components/ReminderWindow.tsx`, `web/src/App.tsx`,
  `web/src/styles.css`, `server/test/followups.test.ts` (new), `server/test/migrations.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-18 (v10.0): one short version label; the plain slide transition

- **Version label:** the sidebar footer shows the server's version as one short label under your
  name (room for two-digit majors), instead of "Server X.Y" over "Web/App X.Y". Out of step, it
  turns red with a "!"; the tooltip says what to update and a click does it, as before. Your name
  no longer gets squeezed by the version and the install button.
- **Phone transitions:** a plain slide, DreyMail's own, is the default (`screenTransitions: 'slide'`);
  the running squirrel (upstream art, kept) is a choice at three speeds, or Off.
- **Files:** `web/src/components/Sidebar.tsx`, `web/src/squirrel.ts`, `web/src/App.tsx`,
  `web/src/components/SettingsDialog.tsx`, `web/src/styles.css`, `shared/types.ts`,
  `server/src/db.ts`, `server/src/routes/api.ts`, `server/test/preferences.test.ts`,
  `web/test/squirrel.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-18 (v9.9): importance, read receipts, printing

- **Importance:** the composer sends high or low importance (Importance, X-Priority and Priority
  headers); incoming importance is read from the same headers and shown in the message list and the
  reader.
- **Read receipts:** the composer can ask for one (Disposition-Notification-To). A message asking
  for one offers Send receipt / Don't send; a receipt is an RFC 8098 disposition notification, and
  either answer sets `$MDNSent` so it isn't asked again.
- **Print:** the reading toolbar prints the message with its header (sanitized body in a frame
  without scripts).
- **Files:** `shared/importance.ts` (new), `web/src/print.ts` (new),
  `web/src/components/ReadReceipt.tsx` (new), `shared/types.ts`, `server/src/imap/summary.ts`,
  `server/src/mail/parse.ts`, `server/src/mail/compose.ts`, `server/src/mail/send.ts`,
  `server/src/imap/mail.ts`, `server/src/routes/api.ts`, `web/src/components/Composer.tsx`,
  `web/src/components/MessageList.tsx`, `web/src/components/Reader.tsx`, `web/src/styles.css`,
  `server/test/importance.test.ts` (new), `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-17 (v9.8): assistant actions that send and write

- **New rule actions:** Forward to (with attachments), Draft a reply (the AI writes it from the
  message and optional instructions; saved in Drafts, never sent), Unsubscribe (one-click, RFC
  8058, only when offered) and Outlook category (Microsoft Graph `categories`, found by
  `internetMessageId`; a label in other mailboxes).
- **Outlook permission:** Mail.ReadWrite is not part of the normal Microsoft sign-in (work tenants
  that limit consent keep working); *Allow Outlook categories* reconnects the mailbox asking for
  it (`allow: ['mail']` on `/api/oauth/microsoft/start`).
- **Files:** `server/src/ai/outgoing.ts` (new), `server/src/ai/engine.ts`, `shared/assistant.ts`,
  `server/src/routes/assistant.ts`, `server/src/oauth/microsoft.ts`, `server/src/routes/microsoft.ts`,
  `server/src/app.ts`, `web/src/components/AssistantDialog.tsx`, `server/test/assistant.test.ts`,
  `CHANGES.md` (9.7 entry: `\All`), `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v9.7): Gmail archive and labels, server settings in the UI

- **Gmail archive:** servers with an All Mail folder (`\All`) and no Archive folder (Gmail) archive
  by moving to All Mail; DreyMail used to make an "Archive" label there.
- **Gmail labels:** the reader shows a Gmail message's labels (X-GM-LABELS) with × to remove one and
  *Add label*; `GET`/`PUT /api/message/labels`.
- **Server settings:** Settings → Server (permission `server.manage`) sets new-mailbox defaults, the
  mail cache, limits, the push contact and the update check. They are stored as the values of
  their environment variables and the configuration is read as the environment over them, with the
  same checks (`loadConfig`); variables set in the environment win and show locked. Mailbox
  defaults apply at once, the rest after a restart (the page says when one is waiting).
- **Files:** `shared/serverSettings.ts` (new), `server/src/serverSettings.ts` (new),
  `web/src/components/ServerAdmin.tsx` (new), `web/src/components/GmailLabels.tsx` (new),
  `server/src/config.ts`, `server/src/app.ts`, `server/src/routes/admin.ts`,
  `server/src/routes/api.ts`, `server/src/imap/mail.ts`, `shared/permissions.ts`,
  `web/src/components/SettingsDialog.tsx`, `web/src/components/Reader.tsx`, `web/src/styles.css`,
  `server/test/gmail.test.ts` (new), `server/test/serverSettings.test.ts` (new), `README.md`,
  `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v9.6): stay signed in, the app lock, one copy in Sent

- **Stay signed in** (Settings → This device): a trusted device's session slides, 30 days from the
  last use, at most a year from signing in (`trusted`, `since` in the session cookie;
  `Sessions.rewrite`; `openJsonWithExpiry` in `crypto.ts`).
- **App lock:** lock after 1 minute to 4 hours without use, or Lock now. Activity is reported by the
  app (`POST /api/session/active`, at most once a minute, only for keys, clicks, touches and
  scrolling); once idle too long the server marks the session locked and answers 423 to everything
  but `/api/session/*` until `POST /api/session/unlock` verifies one of the user's passkeys (user
  verification required). The app shows a lock screen on 423, also when opened locked.
- **Sent copies:** before saving a copy in Sent, DreyMail looks for the message's Message-ID there,
  so servers that file sent mail themselves (Gmail, Microsoft 365 and others) don't get a second one.
- **Files:** `server/src/auth/session.ts`, `server/src/auth/passkeys.ts`, `server/src/crypto.ts`,
  `server/src/routes/api.ts`, `server/src/mail/send.ts`, `server/src/imap/mail.ts`,
  `web/src/components/AppLock.tsx` (new), `web/src/components/SettingsDialog.tsx`, `web/src/api.ts`,
  `web/src/App.tsx`, `web/src/styles.css`, `server/test/deviceSession.test.ts` (new),
  `server/test/sentCopy.test.ts` (new), `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-17 (v9.5): calendar repeats, guests, Teams and Meet, reminders

- **Repeats:** DreyMail's own events repeat every N days, weeks, months or years; weekly on chosen
  weekdays; monthly or yearly on the day, the n-th weekday or the last weekday; until a day or a
  number of times; with occurrences left out. Repeats are expanded in the event's own time zone
  (stored with the event), by the same rule engine on the server and in the browser
  (`shared/rrule.ts`, moved out of `server/src/calendar/ical.ts`), so 9:00 stays 9:00 across
  daylight-saving changes.
- **Series editing:** an occurrence of a repeating event can be changed or deleted on its own, with
  the following ones (DreyMail calendars: the series ends before it and a new one starts), or as the
  whole series. Google and Outlook series are read from the provider (RRULE, Graph patterns) and
  written back; CalDAV occurrences get RECURRENCE-ID overrides or EXDATEs, CalDAV series are no
  longer read-only.
- **Guests:** events have guests (required or optional, with their answers). Google and Outlook send
  invitations themselves; for DreyMail and CalDAV calendars DreyMail emails iTIP REQUEST / CANCEL
  messages from a chosen mailbox (CalDAV events are written with SCHEDULE-AGENT=CLIENT so the server
  doesn't send them too), with a generated VTIMEZONE. Guests' REPLY messages update the event when
  opened.
- **Meetings:** Teams meetings for Outlook calendars that allow them (`isOnlineMeeting`,
  `teamsForBusiness`), Google Meet for Google calendars (`conferenceData`); join links found in
  events (Teams, Meet, Zoom, Webex, GoTo, Whereby, Jitsi) give a Join button.
- **Reminders:** per event (none, at the start, 5 minutes to a week before; 15 minutes for new
  events and accepted invitations). The server looks ahead in every user's visible calendars every
  5 minutes, keeps due reminders in `calendar_alerts`, and notifies every device (Web Push, the
  Android app, and the desktop app over the WebSocket); the app's reminder window offers Join,
  Snooze and Dismiss, in step across devices.
- **Database:** migration adding repeat, reminder, guest and meeting columns to `calendar_events`,
  `meetings` to `calendars`, and the `calendar_alerts` table.
- **Files:** `shared/rrule.ts` (new), `shared/calendar.ts`, `shared/types.ts`,
  `server/src/calendar/localEvents.ts` (new), `server/src/calendar/reminders.ts` (new),
  `server/src/calendar/ical.ts`, `server/src/calendar/remote.ts`, `server/src/calendar/service.ts`,
  `server/src/routes/calendar.ts`, `server/src/mail/send.ts`, `server/src/push/service.ts`,
  `server/src/db.ts`, `server/src/app.ts`, `web/src/components/EventEditor.tsx` (new),
  `web/src/components/ReminderWindow.tsx` (new), `web/src/components/CalendarDialog.tsx`,
  `web/src/components/InviteCard.tsx`, `web/src/hooks.ts`, `web/src/App.tsx`, `web/src/styles.css`,
  `server/test/repeats.test.ts` (new), `server/test/reminders.test.ts` (new),
  `server/test/calendar.test.ts`, `server/test/calendar-sync.test.ts`, `server/test/ical.test.ts`,
  `server/test/migrations.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v9.4): the folder bar as a real tree

- **Folder order:** subfolders were sorted alphabetically after the built-in mailboxes, so the
  subfolders of Inbox or Sent showed far below them (indented as if they belonged to the folder
  above), and folding Inbox hid folders somewhere else in the list. Every folder now sits right
  under its parent, in the built-in order (Inbox, Snoozed, Drafts, Sent, Archive, Junk, Trash) and
  then alphabetically, at every level; Inbox and Sent fold like any folder.
- **Gmail:** the built-in mailboxes inside "[Gmail]" (a container that can't hold mail) move to the
  top level, so folding it never hides Sent, Drafts or Trash; the container is left out when nothing
  else is in it.
- **Pinned folders:** folding works there too; a pinned subfolder sits under its nearest pinned
  parent.
- **Collapsed mailboxes and groups** (and Saved searches) stay collapsed after a reload, per device.
- **Files:** `web/src/folderTree.ts` (new), `web/test/folderTree.test.ts` (new),
  `web/src/components/Sidebar.tsx`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v9.3): image viewer for attached pictures

- **Image viewer:** a click on an attached picture (PNG, JPEG, GIF, WebP, AVIF, BMP) opens it full
  size over the app: the arrows or ← → move between the message's pictures, Download saves the
  one shown, Esc or a click beside it closes. Pictures are fetched once and shown from memory (a
  `blob:` URL of their own type); the server still sends attachments only as downloads. SVG stays
  download-only, as it can carry scripts.
- **Download arrow:** picture chips have a download arrow at their end (with the same progress
  as before); other attachments download with a click, as before.
- **Files:** `web/src/components/ImageViewer.tsx` (new), `web/src/components/Reader.tsx`,
  `web/src/download.ts`, `web/src/styles.css`, `web/test/download.test.ts`, `README.md`,
  `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v9.2): the receiving mailbox as a colored bubble

- **Mailbox bubble:** with several mailboxes, the name of the mailbox a message came to (next to
  "to …" in the message header) is a bubble filled with that mailbox's color, with a navy or white
  label, whichever reads better, instead of a gray outline with a dot. On phones, with the header
  folded, it stays a colored dot.
- **Files:** `web/src/components/Reader.tsx`, `web/src/styles.css`, `web/test/reader.test.ts`,
  `README.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v9.1): server and client versions side by side

- **Two versions at the bottom of the sidebar:** "Server X.Y" and, under it, the version of what
  you use: "Web X.Y" in a browser (the version the page was built as) or "App X.Y" in the desktop
  and Android apps. When they differ the second line turns red with a warning and says which side
  to update: the server's image when an app is newer than the server, the app when it is older (a
  click starts its update check), or the page when it was loaded before the server was updated (a
  click reloads it). The web build carries its version (`__WEB_VERSION__`, from `package.json`).
- **Files:** `shared/versions.ts` (new), `web/src/buildInfo.ts` (new), `web/test/versions.test.ts`
  (new), `web/src/components/Sidebar.tsx`, `web/vite.config.ts`, `web/src/styles.css`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v9.0): readable dropdown lists in dark mode

- **Dropdown lists in dark mode** (the composer's From, and every other select): the list the
  system draws fell back to a white background behind the dark theme's light text, so the options
  were barely readable (seen in the Linux desktop app). Options now get the theme's surface and
  text colors.
- **Files:** `web/src/styles.css`, `README.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v8.9): the calendar as a page of its own

- **Calendar page:** the calendar no longer opens as a dialog; it is a page of its own
  (`/calendar`, so Back and links work) that fills the space of the message list and reader, on
  PCs, tablets and phones (with the folder drawer button there). Choosing a folder in the sidebar
  goes back to mail.
- **Calendar button:** a full-width button right under Compose (and the Sending list), tinted in
  the accent color and filled while the calendar is open, instead of a line among the folders.
- **Files:** `web/src/components/CalendarDialog.tsx`, `web/src/components/Sidebar.tsx`,
  `web/src/App.tsx`, `web/src/routing.ts`, `web/src/styles.css`, `web/test/routing.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v8.8): folding subfolders, on every device

- **Folding subfolders:** folders with subfolders get an arrow in the sidebar that folds them away
  and back; a folded folder's count includes its subfolders' unread mail. Stored in the new
  `collapsedFolders` preference (per mailbox), so every browser and the desktop and Android apps
  show the same.
- **Preferences follow at once:** saving preferences tells the user's other open sessions
  (WebSocket event `preferences`), which fetch them again: folding, Cc/Bcc pins and every other
  setting show on the other devices without reloading.
- **Files:** `web/src/components/Sidebar.tsx`, `web/src/App.tsx`, `web/src/hooks.ts`,
  `web/src/styles.css`, `shared/types.ts`, `server/src/db.ts`, `server/src/routes/api.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v8.7): Sending list under Compose

- **Sending** (right under Compose in the sidebar): mail in its send delay (undo send), with a
  countdown, **Undo** and **Send now**, refreshed every few seconds while anything is waiting. Undo
  stops it and opens it again in the composer as it was (recipients, subject, body, attached files,
  forwarded attachments, reply and draft links), also after the composer and its "Sending…" notice
  are gone. Mail scheduled for later stays under Scheduled. Server: `POST /api/scheduled/:id/undo`
  takes the message back (refused once it is going out); scheduled mail carries `createdAt`, which
  tells a send delay from a send later.
- **Files:** `web/src/sending.ts` (new), `web/src/components/SendingBox.tsx` (new),
  `web/test/sending.test.ts` (new), `server/src/mail/scheduled.ts`, `server/src/routes/api.ts`,
  `server/test/scheduled.test.ts`, `shared/types.ts`, `web/src/App.tsx`, `web/src/api.ts`,
  `web/src/components/Sidebar.tsx`, `web/src/components/ScheduledDialog.tsx`, `web/src/styles.css`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v8.6): Spam, address suggestions and bubbles, Cc/Bcc lines

- **Spam:** a button in the message toolbar (outside Junk) and in the list's selection bar moves
  mail to Junk (made if the mailbox has none), removes `$NotJunk`/`NonJunk` and adds
  `$Junk`/`Junk`, with Undo. The AI assistant learns from it as a move to Junk. Making a missing
  Archive or Junk folder now looks again when it fails (the folder list can be a minute old).
- **Address suggestions** from sent and received mail, per mailbox: senders of mail in the inbox,
  Archive and your own folders (not newsletters, updates or no-reply senders; not Junk, Trash,
  Drafts or All mail), recipients of mail in Sent and of everything sent from DreyMail. Each
  folder's existing mail is counted once, from the mail cache when it has filled, then only new
  mail, so nothing counts twice (also after clearing a cache). Up to 5,000 people per mailbox in
  the new `address_book` table (gone with the mailbox). Matches at the start of an address, name or
  word come first, then people you write to most (a sent message counts three times a received
  one). Settings → General → *Suggest addresses from*: all mailboxes (default), the mailbox you
  write from, its group, or chosen mailboxes. Your own mailboxes' addresses are never suggested.
- **Address bubbles:** in To, Cc and Bcc a complete address becomes a bubble on space, comma,
  semicolon, Enter, Tab or leaving the field; pasted lists become bubbles; Backspace turns the last
  bubble back into text; incomplete entries show in red. The fields stay comma-separated text
  underneath, so drafts, replies and sending are unchanged.
- **Cc and Bcc lines:** shown by themselves or a click away (*Cc* / *Bcc* on the To line). By
  default Cc is shown and Bcc is not. Settings → General → *Cc and Bcc lines* sets it for all
  mailboxes, and per group and per mailbox (a mailbox's choice wins over its group's, a group's
  over all). The pin at the end of each line changes whichever setting applies to the mailbox you
  write from; unpinning keeps the line for the message being written.
- **Files:** `server/src/addressBook.ts` (new), `shared/addressLines.ts` (new),
  `web/src/addresses.ts` (new), `web/src/components/AddressField.tsx` (new),
  `web/src/components/WritingSettings.tsx` (new), `server/test/addressBook.test.ts` (new),
  `web/test/addresses.test.ts` (new), `web/test/addressLines.test.ts` (new), `server/src/db.ts`
  (migration: `address_book`, `address_book_filled`), `server/src/app.ts`,
  `server/src/cache/sync.ts`, `server/src/imap/mail.ts`, `server/src/mail/send.ts`,
  `server/src/routes/api.ts`, `server/src/ai/engine.ts`, `shared/types.ts`,
  `web/src/components/Composer.tsx`, `web/src/components/Reader.tsx`,
  `web/src/components/MessageList.tsx`, `web/src/components/SettingsDialog.tsx`, `web/src/App.tsx`,
  `web/src/api.ts`, `web/src/push.ts`, `web/src/swipe.ts`, `web/src/sticky.ts`,
  `web/src/styles.css`, `server/test/migrations.test.ts`, `server/test/integration/mail.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v8.5): Not spam

- **Not spam** in Junk: a button in the message's toolbar (shown only in the Junk folder), and in
  the list's selection bar when every selected message is in Junk. It moves the messages back to
  the inbox (with Undo), marks them for the server's spam filter (removes `$Junk`/`Junk`, adds
  `$NotJunk`/`NonJunk`; best effort, as not every server keeps such marks), and removes blocked-
  sender entries that caught the sender (their address, or their domain), so their next message
  doesn't go straight back. The AI assistant learns from it as a move to the inbox.
- **Files:** `shared/types.ts`, `server/src/imap/mail.ts`, `server/src/routes/api.ts`,
  `server/src/blocklist.ts`, `server/src/ai/engine.ts`, `web/src/components/Reader.tsx`,
  `web/src/components/MessageList.tsx`, `web/src/App.tsx`, `web/src/swipe.ts`, `web/src/sticky.ts`,
  `server/test/integration/mail.test.ts`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-17 (v8.4): single line spacing when writing

- **Enter starts a new line, not a new paragraph.** New messages, replies and forwards started with
  a `<p>`, so every Enter made another `<p>`, which the editor and every recipient's mail client
  show with a blank line's gap around it: everything looked double-spaced. Lines are now `<div>`s
  (as in Gmail and Outlook), and Enter always makes a `<div>`. The signature keeps a one-line gap
  above it (an inline margin, so recipients see it too). Drafts saved before keep their `<p>`s.
- **Fix to 8.1's cache of every folder** (8.1 to 8.3 were never published: their release runs
  failed these integration tests, so 8.4 is the first release with them):
  - Cached folders other than INBOX and Sent were listed straight from the cache when checked in
    the last 10 minutes, so a draft just saved, or a message just moved or archived there, was
    missing until the background check caught up. Every listing now gives the server its quick
    check first (up to 1.5 s), as INBOX and Sent do; that check runs on the main connection,
    ahead of the background filling.
  - Listing Drafts no longer pulls in the rest of the conversation (a shortcut assumed every
    cached folder was INBOX or Sent).
- **Files:** `web/src/replies.ts`, `web/src/components/Composer.tsx`, `web/src/signature.ts`,
  `web/test/mailto.test.ts`, `server/src/cache/sync.ts`, `server/src/imap/mail.ts`,
  `server/test/cacheWarm.test.ts`, `README.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v8.3): clear a user's mail cache; clickable flatpak notifications

- **Settings → Storage** clears a user's mail cache: per mailbox (the bin button on its row) or all
  of it (*Clear …'s mail cache*), after a confirmation. Their mailboxes, settings and mail on the
  mail servers are untouched; the copy fills again in the background the next time they use
  DreyMail. `DELETE /api/admin/users/:id/cache` and `/api/admin/users/:id/cache/:accountId`.
- **Flatpak: clicking a notification opens the message** (KDE Plasma). Notifications were shown
  with a one-off `gdbus call`, and clicks were listened for with a separate `gdbus monitor`; KDE
  Plasma sends the click only to the connection that showed the notification, which had already
  exited, so the click was lost. The desktop app now shows notifications and hears their clicks
  on one long-lived D-Bus connection of its own (a small built-in D-Bus client, no new
  dependencies). If that connection can't be made, notifications go through `gdbus` as before,
  then Electron's own.
- **Files:** `desktop/dbus.cjs` (new), `desktop/main.cjs`, `desktop/electron-builder.yml`,
  `web/test/desktopDbus.test.ts` (new; against a real `dbus-daemon`, checked against `gdbus`),
  `server/src/routes/admin.ts`, `web/src/components/StorageAdmin.tsx`, `web/src/api.ts`,
  `web/src/styles.css`, `server/test/storage.test.ts`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-17 (v8.2): space used per user

- **Settings → Storage** (administration, for roles that can manage users): the sizes of
  `dreymail.db` and `cache.db` on disk, and every user's share, largest first, as a bar split into
  message lists, kept message content and their own data. Click a user for their mail cache per
  mailbox (folders, messages, lists, content) and their own data by kind (mailboxes and settings,
  pictures, calendar, scheduled mail, AI assistant). Sizes are the stored (encrypted) values,
  without SQLite's overhead. `GET /api/admin/storage`; `formatSize` now goes up to GB.
- **Files:** `server/src/storage.ts` (new), `server/src/cache/store.ts`,
  `server/src/routes/admin.ts`, `server/src/app.ts`, `shared/types.ts`,
  `web/src/components/StorageAdmin.tsx` (new), `web/src/components/SettingsDialog.tsx`,
  `web/src/api.ts`, `web/src/util.ts`, `web/src/styles.css`, `server/test/storage.test.ts` (new),
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v8.1): every folder cached

- **Other folders open at once:** the mail cache now keeps the newest 500 messages
  (`DREYMAIL_CACHE_FOLDER_MESSAGES`, `0` for the old INBOX-and-Sent-only behavior) of every
  folder, not only INBOX and Sent. They are filled one at a time in the background as soon as a
  mailbox is added and whenever a session opens (folders not checked for 10 minutes; up to 100 per
  mailbox, special folders first), on a third IMAP connection of their own so opening messages
  never waits behind it. A folder opened before its turn starts filling right away. A folder
  checked in the last 10 minutes is listed straight from the cache and checked in the background;
  folders gone from the server are dropped from the cache. Conversations in those folders also come
  from the cache instead of header searches on the server.
- **Files:** `server/src/cache/store.ts`, `server/src/cache/sync.ts`, `server/src/imap/pool.ts`,
  `server/src/imap/mail.ts`, `server/src/config.ts`, `server/src/app.ts`,
  `server/test/cache.test.ts`, `server/test/cacheWarm.test.ts` (new), `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-17 (v8.0): install the app; open pages in the app

- **Install the app:** in a browser, a download icon at the bottom of the sidebar (right-click
  hides it) and Settings → This device → *Install DreyMail…* open a dialog for this device:
  Windows installer, Linux flatpak/.deb/.rpm with the commands, Android APK with the "install
  unknown apps" step, Add to Home Screen on iPhone and iPad, web app on Mac (and Chrome/Edge's own
  install prompt where offered). Files are the running version's release assets; the server
  address to enter is shown with a copy button. Hidden inside the apps and installed web apps.
- **Open this page in the app:** the desktop app registers `dreymail://` (Windows registry,
  Linux desktop entry) and the Android app handles it; `dreymail://open?path=/…` opens that page
  of the configured server (paths only, never another site). On Android the web link is an
  `intent://` link that stays in Chrome when the app isn't installed.
- **Files:** `web/src/install.ts` (new), `web/src/components/InstallDialog.tsx` (new),
  `web/src/components/Sidebar.tsx`, `web/src/components/SettingsDialog.tsx`, `web/src/styles.css`,
  `web/test/install.test.ts` (new), `desktop/main.cjs`, `desktop/electron-builder.yml`,
  `android/app/src/main/AndroidManifest.xml`,
  `android/app/src/main/java/io/github/samschultzponsys/dreymail/MainActivity.kt`, `README.md`,
  `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v7.9): auto-replies

- **Settings → Auto-replies:** automatic answers to new mail (templates: out of office, out sick,
  on leave, on vacation, or blank). Each one answers for all mailboxes, or for chosen mailboxes
  and groups; optionally from/until a date and time; on/off switch; how often the same sender
  may get it again (1–30 days, 4 by default). When several apply, the one naming the mailbox
  wins, then its group's, then one for all mailboxes. `{subject}` fills in the original subject.
- **Server:** watches the inboxes of users with an auto-reply on (like blocked senders) and
  answers new mail after blocked senders went to Junk, reading the headers before rules move
  anything. Never answers mailing lists, bulk, automatic, spam-flagged or bounce mail, no-reply
  addresses or the mailbox itself (RFC 3834); replies carry `Auto-Submitted: auto-replied` and
  `X-Auto-Response-Suppress: All`, aren't saved to Sent, and an account sends at most 60 an
  hour. New tables `auto_replies` and `auto_reply_log`.
- **Files:** `server/src/autoReply.ts` (new), `server/src/routes/autoReplies.ts` (new),
  `server/src/app.ts`, `server/src/db.ts`, `server/src/mail/send.ts`, `shared/types.ts`,
  `web/src/components/AutoReplies.tsx` (new), `web/src/components/SettingsDialog.tsx`,
  `web/src/styles.css`, `server/test/autoReply.test.ts` (new), `server/test/migrations.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v7.8): pinned buttons on every message

- **Reader:** the buttons picked in Settings → General ("Buttons pinned to each message") showed
  only on messages of conversations with two or more messages, so they never appeared on a
  single message or in mailboxes with conversations turned off. Now every opened message has
  them (not drafts).
- **Files:** `web/src/components/Reader.tsx`, `web/src/components/SettingsDialog.tsx`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v7.7): Schedule button and longer send delays

- **Composer:** the clock icon is now a labeled **Schedule** button, with more quick times (in 1
  hour, in 3 hours, this evening) besides tomorrow morning/afternoon, Monday morning and a custom
  date and time (no longer one in the past).
- **Settings → General → Send delay (undo send):** presets Off, 10 s, 30 s, 1 min, 2 min, 5 min,
  and *Custom* (minutes and seconds, up to 10 minutes). The server accepts any delay from 0 to
  600 seconds. Delays of a minute or more say "Sending in …" with Undo.
- **Files:** `web/src/components/Composer.tsx`, `web/src/components/SettingsDialog.tsx`,
  `web/src/util.ts`, `web/src/styles.css`, `server/src/routes/api.ts`, `shared/types.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-17 (v7.6): single sign-on replaces the password

- **Settings → Profile → Single sign-on:** connecting your provider now removes the account's
  password. The account signs in with single sign-on (or a passkey) from then on, so the Password
  tab and the administrators' *Set a new password* button go away for it. Connecting asks for
  confirmation first. **Disconnect** asks for a new password (optional when the account has a
  passkey), so the account always keeps a way in.
- **Database:** a migration drops the passwords of accounts that were connected before 7.6.
- **Files:** `server/src/auth/routes.ts`, `server/src/db.ts`, `shared/types.ts`,
  `web/src/components/SingleSignOn.tsx`, `server/test/sso-connect.test.ts`,
  `server/test/migrations.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v7.5): tidier collapsed folder bar

- **Collapsed folder bar** (wide screens): a group's unread count stuck out of the bar, and its
  mailboxes were indented with a side line that pushed the bar sideways (a scrollbar appeared).
  Now a group shows its icon with an unread dot, its mailboxes sit in a panel tinted in the
  group's color, and nothing sticks out. Mailboxes with a built-in icon also show it there (it
  was hidden along with the arrow). Phones and tablets are unchanged.
- **Files:** `web/src/styles.css`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v7.4): new group from the folder bar

- **Folder bar:** right-click its empty space (below the last mailbox, or between sections) for
  *New group…*, which opens the new-group form directly (Save or Cancel returns to the mail), and
  *Mail accounts…*. Only for roles that may change mailboxes; names keep their own menus.
- **Files:** `web/src/components/Sidebar.tsx`, `web/src/components/AccountsDialog.tsx`,
  `web/src/App.tsx`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v7.3): flatpak notifications in the background; mailbox icons in notifications

- **Desktop app, flatpak:** on KDE Plasma, new mail only became a notification while DreyMail was
  the window in front; behind other windows or in the tray it never reached Plasma (not even its
  history), although the app had sent it. The flatpak now sends notifications straight to the
  desktop's notification service with `gdbus` (as a test from inside the sandbox showed works in
  the background), with the icon as a file the desktop can read, and hears clicks through
  `gdbus monitor`. If gdbus fails it falls back to Electron's notifications. deb, rpm and Windows
  are unchanged. `DREYMAIL_NOTIFY_LOG` now also records how each notification went out and whether
  the window was focused.
- **Notification icons:** mailboxes with an uploaded picture or a provider/website icon got the
  plain DreyMail icon, because only PNG was used and those pictures are often JPEG, WebP, ICO or
  SVG. Pictures are now turned into a 128px PNG first.
- **Files:** new `desktop/notify.cjs`, `web/test/desktopNotify.test.ts`; `desktop/main.cjs`,
  `desktop/electron-builder.yml`, `web/src/desktop.ts`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-16 (v7.2): group icons like mailbox icons; right-click a group

- **Group icons:** a group's icon can now be anything a mailbox's can: a built-in icon, your own
  picture (upload, size and background in the same editor), or a provider's or any website's
  icon. Stored like mailbox pictures (new columns on `mailbox_groups`, migration appended at the
  end); `GET/PUT/DELETE /api/groups/:id/icon`. "Mailboxes use the group's color and icon" leaves
  members' icons alone when the group's icon is its own picture.
- **Right-click a group's name** in the folder bar: Edit group… (opens its settings directly;
  Save or Cancel returns to the mail), Collapse/Expand.
- **Files:** `server/src/db.ts`, `server/src/routes/api.ts`, `shared/types.ts`,
  `server/test/migrations.test.ts`, `web/src/components/GroupEditor.tsx`,
  `web/src/components/MailboxIcon.tsx`, `web/src/components/AccountsDialog.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-16 (v7.1): flatpak update restarts DreyMail

- **Desktop app, flatpak:** after the update command installed the new version, the DreyMail that
  was open kept running the old one. Both update commands (curl and install, or install from
  Downloads) now end by closing DreyMail (`flatpak kill`) and starting the new version in its own
  session (`setsid -f flatpak run`), so closing the terminal doesn't close it.
- **Files:** `desktop/update.cjs`, `web/test/desktopUpdate.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-16 (v7.0): drag to rearrange the sidebar

- **Sidebar:** groups and mailboxes can be dragged into another order. A line shows where it will
  land; dropping a mailbox on a group's name puts it in that group (an empty group shows while
  dragging), and "Not in a group" at the bottom takes it out. Kept for the account (all devices);
  a mailbox moved into a group that sets its members' color and icon takes them on. For roles
  that may change mailboxes; not in the narrow icon-only bar.
- **Server:** `PUT /api/sidebar-order` saves the order of groups and mailboxes and each mailbox's
  group (the existing `position` columns; no migration).
- **Files:** new `web/src/sidebarOrder.ts`, `web/test/sidebarOrder.test.ts`;
  `web/src/components/Sidebar.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/styles.css`,
  `server/src/db.ts`, `server/src/routes/api.ts`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-16 (v6.9): desktop notifications for every mailbox; provider icons that work

- **Desktop app notifications:** new mail became a notification only while the window wasn't in
  front, so mail for a second mailbox went unnoticed while you worked in the first. Now every
  mailbox's new mail is a notification, always. The title ends with the mailbox's name and the icon
  is the mailbox's icon in its color. Settings → This device → "Send a test notification for each
  mailbox". The window no longer slows down while hidden (`backgroundThrottling: false`), so
  notifications keep coming from the tray.
- **Provider icons:** Microsoft 365, Outlook/Hotmail and many company sites turned the server away
  (they refuse requests that don't look like a browser, or only redirect to a sign-in page). Pages
  and icons are now fetched with a browser user agent, and when the site gives nothing the public
  favicon services are asked (Google's, up to 128 px, then DuckDuckGo's), with the domain only.
- **Files:** `web/src/App.tsx`, `web/src/components/SettingsDialog.tsx`, `desktop/main.cjs`,
  `server/src/net/siteIcon.ts`, `server/src/net/remoteImages.ts`, `server/test/siteIcon.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v6.8): bigger toolbar with names; buttons on each message

- **Reading toolbar:** a small arrow at its right end switches between compact icons and bigger
  buttons with their names (Reply, Reply all, Forward, Unread, Flag, Archive, Snooze, Move,
  Delete). Kept per device.
- **Buttons on each message:** in a conversation, each opened message has small buttons in its
  header that act on that message only: Reply, Reply all, Forward and Delete by default. Settings →
  General → "Buttons on each message of a conversation" picks them (also Mark read/unread, Flag,
  Archive). New preference `messageButtons`.
- **Files:** `web/src/components/Reader.tsx`, `web/src/components/SnoozeMenu.tsx`,
  `web/src/components/MoveMenu.tsx`, `web/src/components/SettingsDialog.tsx`, `web/src/App.tsx`,
  `web/src/styles.css`, `shared/types.ts`, `server/src/db.ts`, `server/src/routes/api.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v6.7): conversations scroll as one page; faster opening

- **Conversations:** each message's frame is as tall as the message, so a conversation scrolls as
  one page instead of a scroll box per message. Measuring the message needs `allow-same-origin` on
  the frame; scripts stay off (no `allow-scripts`) and the CSP inside still blocks every request
  (README "Security model" updated).
- **Faster opening:** listing folders (with every folder's counts, slow on big accounts) now has
  its own connection, so opening a message never waits behind it. The folder list's one-minute
  memory is kept apart from connections. A message waits at most 5 s for its pictures (it was up
  to 20 s, plus any still loading); the rest keep downloading and show next time.
- **Timing:** opening a message reports where the time went (`Server-Timing`: mail server,
  parsing, pictures) and logs a warning when it took over 3 s.
- **Emoji:** emoji written as two halves (`&#55357;&#56842;`, as Outlook for iOS does) showed as
  "��"; they show as the emoji now, in the message and its preview.
- **Files:** `web/src/components/MessageFrame.tsx`, `web/src/styles.css`, `server/src/imap/pool.ts`,
  `server/src/imap/mail.ts`, `server/src/imap/snippet.ts`, `server/src/net/remoteImages.ts`,
  `server/src/mail/sanitize.ts`, `server/src/routes/api.ts`, `server/test/remoteImages.test.ts`,
  `server/test/sanitize.test.ts`, `server/test/mime.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-16 (v6.6): flatpak fallback command works from any folder

- **Desktop app, flatpak:** the fallback update command ("Download instead") pointed at the file in
  the current folder (`./DreyMail-…flatpak`), which fails when the terminal opens in the home folder.
  It now points at the Downloads folder (`xdg-user-dir DOWNLOAD`, else `~/Downloads`). The main
  command (curl, then install) is unchanged.
- **Files:** `desktop/update.cjs`, `web/test/desktopUpdate.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-16 (v6.5): signatures made for Outlook; pictures sent as inline attachments

- **Import from Outlook files** (Settings → Signatures → a signature): choose the .zip a signature
  tool gives you, or its .htm file and its pictures. The pictures are put into the signature, the
  HTML is cleaned (nothing in it can run), and it shows in the editor to check before saving.
  The .zip is read in the browser (no new dependency).
- **Bigger signatures:** up to 1.5 MB, pictures included (it was 100,000 characters, too small for
  an animated logo, so such a signature couldn't be saved).
- **Table layout kept:** the cleaner now keeps `cellpadding`, `cellspacing`, `border`, `width`,
  `height`, `valign` and `bgcolor` on tables and cells, and `border` on pictures, which signatures
  made for Outlook rely on.
- **Pictures in sent mail:** pictures inside a message (pasted, or a signature's) were sent as
  data: URLs, which Gmail and Outlook on the web don't show; the option meant to turn them into
  attachments only works with nodemailer's transport, not the composer DreyMail uses. They are now
  sent as inline (cid:) attachments, the same picture once. Drafts keep them inside the HTML, so
  they open again in the editor.
- **Files:** new `web/src/signatureImport.ts`, `web/test/signatureImport.test.ts`;
  `web/src/components/SignaturesSettings.tsx`, `web/src/styles.css`, `server/src/mail/compose.ts`,
  `server/src/mail/send.ts`, `server/src/routes/api.ts`, `server/test/mime.test.ts`, `README.md`,
  `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v6.4): longer notification previews; links never replace the app

- **Notification previews:** "Sender, subject and the start of the message" now shows up to about
  1,000 characters of the message with its paragraphs (it was one line of about 180), stopping
  where the signature ("-- ") or the quoted earlier message ("On … wrote:") starts. Collapsed, the
  notification shows the subject; expanded, the text.
- **Links:** a link in DreyMail's own pages (for example in a signature's preview) could open the
  other site in place of the app; in the desktop and Android apps that left no way back. Links to
  other sites now always open in a new window (the browser, from the apps); links in text being
  edited don't open; a signature's preview opens the signature instead.
- **Desktop app:** DreyMail menu → Back (Alt+Left, or the mouse's back button) and Back to DreyMail
  (Ctrl+Shift+H, also in the tray menu), in case the window ever shows another site.
- **Files:** new `web/src/linkGuard.ts`, `web/test/linkGuard.test.ts`; `web/src/main.tsx`,
  `web/src/styles.css`, `desktop/main.cjs`, `server/src/imap/snippet.ts`, `server/src/imap/summary.ts`,
  `server/src/imap/pool.ts`, `server/src/push/notify.ts`, `server/test/mime.test.ts`,
  `server/test/push.test.ts`, `server/test/integration/push.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-16 (v6.3): flatpak update in one command

- **Desktop app, flatpak:** when an update is out, the app's first suggestion is one command that
  downloads the new flatpak with curl and installs it (`curl -fL -o /tmp/… <release file> &&
  flatpak install --user --reinstall -y /tmp/…`); "Copy command" puts it on the clipboard. The
  fallback, "Download instead", opens the download and copies the install command for the saved
  file, as before. deb, rpm and Windows are unchanged.
- **Files:** `desktop/update.cjs`, `desktop/main.cjs`, `web/test/desktopUpdate.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v6.2): dialogs stay open on a click outside; minimize to the tray

- **Dialogs:** Accounts (adding or editing a mailbox), Settings, the AI assistant and the calendar
  no longer close when you click outside them, which lost what you had typed. Close them with ×
  or Cancel. What's new and Scheduled still close on a click outside.
- **Desktop app (Linux and Windows):** "Minimize to the tray" (on by default; Settings → This
  device, the tray menu or the DreyMail menu): minimizing hides the window to the tray. A click on
  the tray icon now shows or hides the window (it only showed it before); the tray menu has
  "Show / hide DreyMail" for Linux desktops where a click opens the menu.
- **Files:** `desktop/main.cjs`, `desktop/preload.cjs`, `web/src/desktop.ts`,
  `web/src/components/SettingsDialog.tsx`, `web/src/components/AccountsDialog.tsx`,
  `web/src/components/AssistantDialog.tsx`, `web/src/components/CalendarDialog.tsx`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v6.1): mailbox icon from any provider or website

- **Icon picker:** besides "Use <provider>'s icon" for the mailbox's own address, a list ("Icon of
  a provider…": Gmail, Google Workspace, Outlook / Hotmail, MSN, Microsoft 365, Yahoo, AOL, iCloud,
  Proton, Tuta, Purelymail, Fastmail and more) and "Another website…" fetch an icon whatever the
  address is. Same fetching rules as before (public addresses only, size limits), into the same
  editor.
- **Files:** `server/src/net/siteIcon.ts`, `server/src/routes/api.ts`,
  `web/src/components/MailboxIcon.tsx`, `web/src/styles.css`, `server/test/siteIcon.test.ts`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v6.0): notification previews; right-click a mailbox's name

- **Notification previews:** "Show in notifications" has a third choice, "Sender, subject and the
  start of the message". For a single new message the server fetches the first bytes of its text
  (quoted lines left out) and shows them under the subject; several at once stay one line each.
  If the text can't be fetched, the notification still goes out with sender and subject.
- **Right-click a mailbox's name** in the folder bar: edit the mailbox (opens its settings
  directly; Save or Cancel returns to the mail), collapse/expand, show all or only pinned folders,
  AI assistant. Edit only shows for roles that may change mailboxes.
- **Files:** new `web/src/components/MailboxMenu.tsx`; `shared/types.ts`, `server/src/push/notify.ts`,
  `server/src/imap/pool.ts`, `server/src/routes/api.ts`, `web/src/components/Sidebar.tsx`,
  `web/src/components/AccountsDialog.tsx`, `web/src/components/SettingsDialog.tsx`,
  `web/src/App.tsx`, `web/src/styles.css`, `server/test/push.test.ts`,
  `server/test/integration/push.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v5.9): notification content setting in the Android app

- **Android:** "Show in notifications" (sender and subject, or only "New message" and the account)
  was only in the browser's Settings → This device; the Android app shows it there too now, with a
  note that the phone's lock screen settings may still hide the content.
- **Files:** `web/src/components/SettingsDialog.tsx`, `README.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v5.8): phone layout fix

- **Phones and tablets:** 5.7's resizable folder bar left an empty block above the message list on
  phones (the hidden folder drawer took up space) and stopped the folder drawer sliding over the list
  on tablets. The positioning the grips need now applies only where they show.
- **Files:** `web/src/styles.css`, `README.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v5.7): grips on the pane edges; resizable folder bar

- **Grips:** the draggable edges of the message list and of the folder bar show a small dotted grip
  (cyan on hover), so it's clear they can be dragged.
- **Folder bar width:** on PCs it can be dragged wider or narrower too (180–440 px), kept per device
  like the list's width; double-click resets. Collapsed (icons only) it stays narrow.
- **Files:** new `web/src/components/PaneResizer.tsx`; `web/src/listWidth.ts`,
  `web/src/components/MessageList.tsx`, `web/src/components/Sidebar.tsx`, `web/src/App.tsx`,
  `web/src/styles.css`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v5.6): fixes; first release with 5.3–5.5

5.3, 5.4 and 5.5 were never released: the release checks (integration tests against a real mail
server) failed on the two problems below. 5.6 brings all of their changes.

- **Fix: folder lists right after a change.** Marking mail read or unread, moving, archiving (which
  can create the Archive folder), sending and the like now mark the mailbox's remembered folder list
  as changed, and the next request waits for the real counts instead of showing the remembered ones
  for up to 30 seconds. A fetch overtaken by a change no longer overwrites the newer list.
- **Fix: "your own domains" for images** now means exactly the domains of your mailboxes: not their
  subdomains (a newsletter from news.yourdomain.com doesn't count), and never public mail domains
  (gmail.com, outlook.com, yahoo.com…), which would have loaded images for every Gmail sender.
- **Files:** `server/src/imap/mail.ts`, `server/src/mail/imageAllowlist.ts`,
  `server/src/routes/api.ts`, `server/test/autoImages.test.ts`, `README.md`, `package.json`,
  `package-lock.json`.

## 2026-11-16 (v5.5): folder lists kept across restarts and kept current

- **Folder lists** (with unread counts) are saved in the encrypted mail cache (`cache.db`), so after
  a restart the sidebar still shows at once on any device. Every 5 minutes the server refreshes the
  lists of mailboxes people are using (open sessions, notifications, the AI assistant), three mail
  servers at a time; new mail marks a mailbox's list out of date so its counts catch up. One fetch
  per mailbox at a time, and none while a list is less than 30 seconds old.
- **Files:** `server/src/cache/store.ts` (`folder_lists`, created in place: cached mail is kept),
  `server/src/imap/mail.ts`, `server/src/imap/pool.ts`, `server/src/app.ts`, new
  `server/test/folderLists.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v5.4): resizable message list, folders at once, Settings tabs on phones

- **Message list width:** on tablets and PCs, drag the right edge of the message list (the line
  turns cyan); the width is kept per device (browser storage), double-click resets it, and the
  reading pane always keeps at least 320 px.
- **Folders at once:** the server remembers each mailbox's last folder list and answers with it
  right away while it fetches a fresh one (the sidebar picks that up seconds later), so opening
  DreyMail no longer waits for the mail server to reconnect and recount every folder. (It isn't
  stored per computer; the wait came from the server's idle connection being closed.)
- **Settings on phones:** each tab group gets a full-width row whose tabs scroll sideways, instead
  of the groups wrapping into a staircase.
- **Files:** new `web/src/listWidth.ts`; `server/src/imap/mail.ts`, `server/src/routes/api.ts`,
  `shared/types.ts`, `web/src/hooks.ts`, `web/src/App.tsx`, `web/src/components/MessageList.tsx`,
  `web/src/styles.css`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v5.3): images from people you know, faster sidebar, sidebar choices

- **Settings → Images → Load images by themselves:** in mail from your own domains (the domains of
  your mailboxes) and from people you have written to, both on by default; and, off by default,
  when every image is on the sender's own domain (they can then see that you opened it). The
  "always load from" list works as before; mail that fails DMARC never loads images by itself.
- **Sidebar:** each mailbox's folders are fetched on their own, so one slow mailbox (like a first
  Outlook sign-in) no longer holds up the others'. Settings → General → **Sidebar shows**: Calendar,
  Scheduled and Saved searches can be hidden.
- **Files:** `server/src/mail/imageAllowlist.ts`, `server/src/imap/mail.ts`,
  `server/src/routes/api.ts`, `server/src/db.ts`, `shared/types.ts`, `web/src/api.ts`,
  `web/src/hooks.ts`, `web/src/App.tsx`, `web/src/components/SettingsDialog.tsx`, new
  `server/test/autoImages.test.ts`, `server/test/imageAllowlist.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v5.2): pinned folders

- **Sidebar:** a pin button on each folder (on hover). A mailbox with pinned folders shows its name
  and just those; a "──── ⌄ ────" line under them (with the unread count of the hidden folders)
  shows all of them, and "──── ⌃ ────" folds them away again. Without pins, everything shows as
  before. Saved per mailbox, on every device.
- **Files:** `server/src/db.ts` (`accounts.pinned_folders`), `server/src/routes/api.ts`,
  `shared/types.ts`, `web/src/api.ts`, `web/src/App.tsx`, `web/src/components/Sidebar.tsx`,
  `web/src/styles.css`, `server/test/migrations.test.ts`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-16 (v5.1): conversations or single messages, per mailbox

- **Accounts → edit a mailbox → Message list:** *Conversations* (a message and its replies are one
  row, read together, as before) or *Single messages* (every message its own row). Works for every
  kind of mailbox; in All inboxes each mailbox follows its own choice.
- **Files:** `server/src/db.ts` (`accounts.threaded`), `server/src/routes/api.ts`, `shared/types.ts`,
  `shared/threads.ts`, `web/src/App.tsx`, `web/src/components/AccountsDialog.tsx`,
  `web/test/conversations.test.ts`, `server/test/migrations.test.ts`, `README.md`, `ROADMAP.md`,
  `package.json`, `package-lock.json`.

## 2026-11-16 (v5.0): your mail provider's own icon

- **Mailbox icons:** "Use Gmail's icon" (or Outlook's for Outlook, Hotmail, Live and MSN addresses,
  Yahoo Mail's, AOL's, iCloud's, Proton Mail's, Fastmail's, Zoho's, GMX's, Yandex's, or any other
  domain's own, e.g. Purelymail) fetches the provider's icon from its website and opens it in the
  picture editor to size and place. The server reads the icons the provider's page lists (largest
  first, no SVG), then /apple-touch-icon.png and /favicon.ico, with the same protections as remote
  images (public addresses only, size limits). No logos are bundled: they are their owners'
  trademarks.
- **Files:** new `server/src/net/siteIcon.ts`, `server/test/siteIcon.test.ts`;
  `server/src/routes/api.ts`, `web/src/components/MailboxIcon.tsx`,
  `web/src/components/AccountsDialog.tsx`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-16 (v4.9): mailbox groups

- **Mailbox groups** (Accounts → Groups → New group): a name, a color, an icon, the mailboxes in it,
  "Mailboxes use the group's color and icon" (applied to every member when saved; one mailbox can
  still be changed afterwards) and "Notify me about new mail in these mailboxes" (off: no new-mail
  notifications for any of them, on any device). In the sidebar each group is a section header
  with its icon, color and total unread count that expands and collapses; its mailboxes sit under
  it. A mailbox is in one group at a time; deleting a group keeps its mailboxes.
- **Files:** new `web/src/components/GroupEditor.tsx`, `server/test/groups.test.ts`;
  `server/src/db.ts` (`mailbox_groups`, `accounts.group_id`), `server/src/routes/api.ts`,
  `server/src/app.ts` (notifications), `shared/types.ts`, `web/src/api.ts`, `web/src/App.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/components/AccountsDialog.tsx`, `web/src/styles.css`,
  `server/test/migrations.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-16 (v4.8): reminder to renew the Outlook client secret

- **Settings → Outlook:** the guide says to choose a **24-month** client secret, and a new
  **Client secret expires on** field fills in two years from today when a secret is pasted. Saving a
  new date puts an all-day "Renew DreyMail's Outlook client secret" event, with the steps, two weeks
  before it expires in every Superadmin's own DreyMail calendar (a "Personal" one is made if they
  have none). Saving another date moves it.
- **Files:** new `server/src/calendar/adminReminders.ts`, `server/test/adminReminders.test.ts`;
  `server/src/routes/microsoft.ts`, `shared/types.ts`, `web/src/api.ts`,
  `web/src/components/AdminSettings.tsx`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-16 (v4.7): your own picture while adding a mailbox

- **Add account:** the icon picker's "Upload a picture" works right away; the picture is kept in the
  form and saved with the new mailbox (it used to need saving the mailbox first, then editing it).
- **Files:** `web/src/components/MailboxIcon.tsx`, `web/src/components/AccountsDialog.tsx`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-15 (v4.6): fix "no such column: auth" when signing in with Google or Microsoft

- **Fix:** servers first set up on 2.0 or 2.1 never got the database columns for Google and Microsoft
  sign-in (that migration had been inserted out of order, before 2.0's, so those databases skipped
  it), and adding Gmail or Outlook by signing in failed with "no such column: auth". A repair step
  at the end of the migrations adds them; nothing else changes. Migrations are now pinned as
  append-only by a test.
- **Files:** `server/src/db.ts`, new `server/test/migrations.test.ts`, `CLAUDE.md`, `README.md`,
  `package.json`, `package-lock.json`.

## 2026-11-15 (v4.5): Gmail choice without the setup note once it's done

- **Add account → Gmail:** "Needs a one-time setup by an administrator" only shows while Sign in with
  Google isn't set up on the server.
- **Files:** `web/src/components/AccountsDialog.tsx`, `README.md`, `package.json`, `package-lock.json`.

## 2026-11-15 (v4.4): connect single sign-on to your account

- **Settings → Profile → Single sign-on → Connect** (the provider's name): connects the server's
  OIDC provider to the account you're signed in to. Afterwards, signing in with it (including
  automatic sign-in) opens that account with its mailboxes and settings, instead of a new, empty
  one. The password keeps working as a fallback; **Disconnect** (only when a password or passkey is
  left) undoes it. An identity that already made its own account is moved over. Linking needs
  both: being signed in to the account and signing in at the provider; accounts are never joined
  by email address. Settings → Users shows "Password + single sign-on" for connected accounts.
- **Files:** new `web/src/components/SingleSignOn.tsx`, `server/test/sso-connect.test.ts` (with a
  small fake OIDC provider); `server/src/db.ts` (`user_identities`), `server/src/auth/routes.ts`,
  `server/src/auth/session.ts`, `server/src/routes/admin.ts`, `shared/types.ts`,
  `web/src/components/SettingsDialog.tsx`, `AdminSettings.tsx`, `web/src/main.tsx`, `App.tsx`,
  `web/src/styles.css`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-15 (v4.3): mail providers to pick from

- **Add account → Other email** starts with a **Mail provider** list: iCloud, Yahoo, AOL, Fastmail,
  Purelymail, Proton Mail (Bridge), Zoho (and EU), mailbox.org, Posteo, Migadu, Runbox, Disroot, GMX
  (two regions), WEB.DE, mail.com, Yandex, Xfinity, AT&T, Namecheap Private Email, Hostinger, IONOS,
  Infomaniak and Gmail (app password). Picking one fills in the IMAP and SMTP servers, ports,
  security and the "save a copy to Sent" choice, and shows what else the provider needs (an app
  password, turning IMAP on…); the server fields then collapse to a summary. Typing your address
  picks the provider by itself; Outlook addresses are pointed to Microsoft sign-in. **Custom**
  (or "Change them") shows every field to type in. Editing an account shows its provider.
- **Files:** new `shared/mailProviders.ts`, `server/test/mailProviders.test.ts`;
  `web/src/components/AccountsDialog.tsx`, `web/src/accountForm.ts`, `web/src/styles.css`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-15 (v4.2): Gmail's two ways, side by side

- **Add account → Gmail / Google Workspace** now shows both ways next to each other, each with what
  you get and what you give up: **Sign in with Google** (Google Calendar, invitations answered
  through Google, no app password; needs the one-time admin setup and shows Google's "unverified
  app" notice) and **App password** (works right away; no Google Calendar, invitations answered by
  email, needs 2-Step Verification, stops when you change your Google password). The app password
  way fills in Gmail's servers, and links to where Google makes app passwords. Other providers
  are under "Other email".
- **README:** the same comparison as a table, and how to switch an existing Gmail.
- **Files:** `web/src/components/AccountsDialog.tsx`, `web/src/accountForm.ts`, `web/src/styles.css`,
  `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-15 (v4.1): privacy page

- **Privacy page** at `/privacy` (e.g. `https://mail.example.com/privacy`): what a DreyMail server
  keeps, what leaves it, how Google and Microsoft data is used (with the Google API Services User
  Data Policy / Limited Use statement), the optional AI assistant, and removing your data. Google
  asks for a privacy policy link on your own domain before an OAuth app can be published; this is
  it. Linked next to "Source code".
- **Settings → Google** walkthrough: the Branding step (no logo, home page, privacy policy and your
  own authorized domain, filled in for the address you're on).
- **Files:** new `web/public/privacy.html`; `server/src/app.ts` (the `/privacy` route),
  `web/src/components/SourceLink.tsx`, `web/src/components/AdminSettings.tsx`,
  `server/test/spa.test.ts`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-15 (v4.0): automatic single sign-on, /login, easier OIDC setup; credits trimmed

- **Sign in automatically with OIDC** (Settings → Sign-in, or `DREYMAIL_OIDC_AUTO_LOGIN=true`, which
  wins and shows locked): opening DreyMail goes straight to the provider.
  - **`/login`** always shows the sign-in page with every option (password, passkey, the provider
    button): the way back in when the provider is down.
  - No loops: after signing out DreyMail waits on the sign-in page; a failed or refused sign-in,
    or a provider that can't be reached, comes back to `/login` with the reason (it used to show a
    bare error page); and it never retries automatically within a minute.
- **OIDC setup:** Settings → Sign-in shows the redirect URI and sign-out redirect URI for the address
  you're on, with Copy buttons, and warns when that differs from `DREYMAIL_BASE_URL`.
- **Credits:** the app is DreyMail's own. The sign-in page, Settings, What's new and the desktop
  app's About box no longer name the project DreyMail started from; the source code link the
  AGPL requires stays ("DreyMail X.Y · Source code · AGPL-3.0"). The README credits it once, in a
  short section at the very end. `NOTICE` keeps the copyright notices; its additional term now
  only asks that the file is preserved. What's new shows the latest 10 versions, without license
  bookkeeping, and links to the full history.
- **README:** status wording, the old note about variable names, and calendars no longer listed as
  out of scope.
- **Files:** `server/src/config.ts`, `server/src/loginSettings.ts`, `server/src/auth/routes.ts`,
  `server/src/routes/admin.ts`, `shared/types.ts`, `web/src/components/Login.tsx`, `App.tsx`,
  `AdminSettings.tsx`, `SourceLink.tsx`, `ChangelogDialog.tsx`, `web/src/styles.css`,
  `desktop/main.cjs`, `desktop/electron-builder.yml`, `NOTICE`, `README.md`, `CLAUDE.md`, tests
  (`server/test/admin.test.ts`, `web/test/changelog.test.ts`), `package.json`, `package-lock.json`.

## 2026-11-15 (v3.9): Google, Outlook and CalDAV calendars; answering invitations

- **Docs:** `ROADMAP.md` has its own Calendar section; `CLAUDE.md` asks for the roadmap to be
  updated with every feature.
- **Provider calendars in the calendar:**
  - **Google and Outlook:** mailboxes added with Google or Microsoft sign-in bring their calendars,
    grouped under the mailbox. The calendar list is mirrored (each keeps its checkbox and color),
    events are read live for the range on screen, and changes are written straight back through
    the Google Calendar API and Microsoft Graph. Changing one occurrence of a repeating event changes
    that occurrence only. Signing in now also asks for calendar access; mailboxes added earlier show
    a Reconnect button. Administrators turn on the Google Calendar API in their Google Cloud project.
  - **CalDAV** (Nextcloud, iCloud, Fastmail, Radicale…): connect with a server address, username
    and password (stored encrypted). DreyMail finds the calendars (RFC 6764 / 4791), reads events
    with the server expanding repeats (or expands them itself), and adds, changes (keeping alarms,
    attendees and other details) and deletes events. Repeating CalDAV events are read-only.
    Connections follow the mail-host rule for internal addresses (`DREYMAIL_BLOCK_PRIVATE_MAIL_HOSTS`).
  - Problems (no calendar access, API turned off, wrong password) show under the calendar's group.
    A refresh button reloads everything.
- **Invitations:** messages with a calendar invitation show a card (what, when, where, who, repeats)
  with Yes / Maybe / No.
  - Google and Outlook mailboxes answer through their calendar, which tells the organizer.
  - Other mailboxes email an iTIP REPLY (RFC 5546) to the organizer and add accepted invitations to
    a calendar you pick. Declining removes what was added; canceled invitations offer to remove it.
  - Time zones from Outlook (Windows names) and the invitation's own VTIMEZONE are understood.
- **iCalendar support** (`server/src/calendar/ical.ts`): parsing that keeps unknown properties,
  time zones, repeat rules (RRULE with BYDAY, BYMONTHDAY, BYSETPOS, COUNT, UNTIL, EXDATE and changed
  occurrences) and writing.
- **Files:** new `server/src/calendar/` (`ical.ts`, `remote.ts`, `service.ts`, `invites.ts`),
  `web/src/components/InviteCard.tsx`, tests `server/test/ical.test.ts`,
  `server/test/calendar-sync.test.ts` and `server/test/caldav-live.test.ts` (runs against a real
  CalDAV server when one is given). Also `server/src/db.ts` (provider calendars, CalDAV connections,
  invitation answers), `server/src/routes/calendar.ts`, `server/src/app.ts`, `server/src/mail/send.ts`
  (invitation answers), `server/src/mail/parse.ts` (invitations in the message),
  `server/src/oauth/google.ts` and `microsoft.ts` (calendar access), `shared/calendar.ts`,
  `shared/types.ts`, `web/src/components/CalendarDialog.tsx`, `Reader.tsx`, `AdminSettings.tsx`,
  `web/src/styles.css`, `README.md`, `ROADMAP.md`, `package.json`, `package-lock.json`.

## 2026-11-15 (v3.8): Calendar

- **Calendar**, opened from the sidebar:
  - Month, week, day and agenda views, with Today and previous/next; phones open on the agenda.
  - Your calendars, each with a color and a show/hide checkbox, listed under "My calendars" or
    grouped under one of your mailboxes. Everyone gets a "Personal" calendar to start with.
  - Events with a title, a time or all day, location, notes, and repeats (daily, weekly, monthly,
    yearly, optionally until a date). Repeats are expanded in your time zone. All-day events stay
    on their dates across daylight-saving changes.
  - Sharing with other DreyMail users, to view or to edit. Shared calendars appear under "Shared
    with me", where each person can hide or leave them. Every request checks access (owner, edit,
    view).
  - Syncing with Google, Outlook and CalDAV and answering invitations come in a later release.
- **Fix (same version):** the first 3.8 build failed because a file notice in `web/src/styles.css`
  ended up outside its comment; it is back inside, and 3.8 is released from the fixed commit.
- **Files:** new `shared/calendar.ts`, `server/src/routes/calendar.ts`,
  `web/src/components/CalendarDialog.tsx`, `server/test/calendar.test.ts`. Also the calendar
  tables migration (`server/src/db.ts`), `server/src/app.ts`, `web/src/components/Sidebar.tsx`,
  `web/src/App.tsx`, `web/src/styles.css`, `README.md`, `ROADMAP.md`, `package.json`,
  `package-lock.json`.

## 2026-11-15 (v3.7): Automatic inbox tabs

- **Inbox tabs:** All, Personal, Updates and Newsletters, each with its unread count, in an inbox
  and in All inboxes. Sorting needs no AI:
  - **Newsletters:** mailing-list headers (List-Id, List-Unsubscribe, Precedence: bulk).
  - **Updates:** automated mail (Auto-Submitted, or a no-reply / notifications / billing style
    sender).
  - **Personal:** everything else.
  - Switch the tabs off in Settings → General.
- **Files:** new `shared/categories.ts`; the list fetch reads those headers and each summary
  carries its category (`server/src/imap/summary.ts`, `shared/types.ts`). The mail cache stores it,
  and its format version goes up, so the cache rebuilds itself once after updating
  (`server/src/cache/store.ts`). Also the `inboxTabs` preference (`server/src/db.ts`,
  `server/src/routes/api.ts`), `web/src/components/MessageList.tsx`, `web/src/App.tsx`,
  `web/src/components/SettingsDialog.tsx`, `web/src/styles.css`.
- Tests: `server/test/conveniences.test.ts`.

## 2026-11-15 (v3.6): Passkeys (fingerprint, face, PIN, security key)

- **Passkeys:** sign in with a fingerprint, face, device PIN or security key, without typing a
  password. Add and remove them in Settings → Profile → Passkeys; the sign-in page offers **Sign in
  with a passkey** once one exists. They are discoverable (no username needed), bound to
  DREYMAIL_BASE_URL's host, need https (or localhost), and work alongside password and OIDC
  sign-in. Signatures are checked by SimpleWebAuthn (new dependencies `@simplewebauthn/server`
  14.0.3 and `@simplewebauthn/browser` 14.0.0, MIT). Sign-in attempts are rate-limited, and each
  challenge works once and only for five minutes.
- **Files:** new `server/src/auth/passkeys.ts` and the `passkeys` table (`server/src/db.ts`);
  `server/src/auth/session.ts`, `server/src/auth/routes.ts` (`/auth/methods` says whether passkeys
  exist), `server/src/app.ts`, `shared/types.ts`; new `web/src/components/Passkeys.tsx`;
  `web/src/components/Login.tsx`, `web/src/components/SettingsDialog.tsx`, `web/src/api.ts`.
- Tests: `server/test/passkeys.test.ts`; checked end to end with a virtual authenticator (add a
  passkey, sign out, sign in with it).

## 2026-11-15 (v3.5): Send later and undo send

- **Send later** from the composer's clock button: tomorrow morning, tomorrow afternoon, Monday
  morning, or any date and time. The **Scheduled** list in the sidebar has Send now and Cancel, and
  failed sends are shown with their error.
- **Undo send:** after Send the message waits 10 seconds by default (Off, 5, 10, 20 or 30 in
  Settings → General). **Undo** in the toast cancels it and reopens the composer with everything,
  attachments included.
- **Both are sent by the server:** the message, attachments included, is sealed like account
  passwords and sent when due, even with no browser open. A send interrupted by a restart is
  marked failed rather than resent blindly.
- **Files:** new `server/src/mail/scheduled.ts` and the `scheduled_sends` table
  (`server/src/db.ts`); the `sendAt` field and `/api/scheduled` (`server/src/routes/api.ts`);
  `server/src/app.ts`; `undoSendSeconds` and `ScheduledSend` (`shared/types.ts`); new
  `web/src/components/ScheduledDialog.tsx`; `web/src/components/Composer.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/components/SettingsDialog.tsx`, `web/src/App.tsx`,
  `web/src/api.ts`, `web/src/hooks.ts`, `web/src/styles.css`.
- Tests: `server/test/scheduled.test.ts`.

## 2026-11-15 (v3.4): Copy codes, unsubscribe, block sender, mailbox health

- **Verification codes:** sign-in, 2FA and one-time codes are found near the words that announce
  them. They can be copied from the message list (a chip on the row) and from the open message
  (Copy) (new `shared/codes.ts`; `server/src/mail/parse.ts`, `web/src/components/MessageList.tsx`,
  `web/src/components/Reader.tsx`).
- **Unsubscribe button** on mailing-list mail: done by DreyMail where the sender offers one-click
  (RFC 8058, https only, public hosts, no cookies); otherwise their page or address opens (new
  `shared/unsubscribe.ts` and `server/src/net/unsubscribe.ts`; `/api/unsubscribe` in
  `server/src/routes/api.ts`).
- **Block sender:** an address, or a whole domain with `@example.com`, per mailbox. Their mail
  already in the inbox and arriving later goes to Junk, without a notification. Blocked senders are
  listed in Settings → General with Unblock (new `server/src/blocklist.ts` and `blocked_senders`
  table; `server/src/db.ts`, `server/src/app.ts`, `server/src/ai/engine.ts` keeps their inboxes
  watched, `web/src/components/SettingsDialog.tsx`, `web/src/api.ts`).
- **Mailbox health:** a mailbox with a problem (sign-in expired, server unreachable) shows a
  warning in the sidebar with a link to fix it in Accounts (`web/src/components/Sidebar.tsx`).
- Tests: `server/test/conveniences.test.ts`.

## 2026-11-15 (v3.3): AI assistant learning mode

- **Learning mode** per mailbox: 3 days, 1 week, 2 weeks or 1 month (30 days at most in all, with
  Extend and End now).
  - **While on,** the AI classifies each new message (kind of mail, importance; one extra request
    per message, shown up front) and DreyMail notes what you do with it: archive, delete, move,
    read, star, snooze, reply, or leaving it unread, including mail that left the inbox in other
    apps.
  - **Suggesting rules:** one AI request with a per-sender summary, never raw mail. Each suggestion
    comes with its evidence, to Accept, Edit or Reject.
  - **When it ends,** the next time DreyMail opens it goes straight to the review (Remind me
    tomorrow / Finish review).
  - Learning mailboxes are watched like assistant mailboxes, and an hourly check lets expired
    periods stop.
- **Files:**
  - Server: `ai_mailboxes.learning_*` and the new `ai_observations` table (`server/src/db.ts`);
    `server/src/ai/store.ts`, `server/src/ai/engine.ts` (learnArrivals, observeAction, suggest),
    `server/src/routes/assistant.ts`; actions report to learning before they run
    (`server/src/routes/api.ts`, `server/src/app.ts`).
  - Shared: `shared/assistant.ts`.
  - Web: `web/src/components/AssistantDialog.tsx` (Learning tab), `web/src/App.tsx` (review on
    open), `web/src/api.ts`, `web/src/styles.css`.
- Tests: `server/test/assistant.test.ts`.

## 2026-11-15 (v3.2): Source code link; AI cleanup of existing mail and senders

- **Source code link (AGPL §13):** "DreyMail X.Y · Source code · based on Ratatoskr by Magnus Pihl ·
  AGPL-3.0" on the sign-in page, in What's new and in Settings → Profile. It links to this
  repository at the running version (new `web/src/components/SourceLink.tsx`;
  `/auth/methods` carries the version, `server/src/auth/routes.ts`, `shared/types.ts`,
  `web/src/components/Login.tsx`, `web/src/components/ChangelogDialog.tsx`,
  `web/src/components/SettingsDialog.tsx`).
- **AI assistant → Clean up:**
  - **Sort existing mail:** runs the rules once over the newest 50–2,500 inbox messages, in the
    background, with progress and Stop. It stops by itself at the daily limit.
  - **Senders:** the inbox grouped by sender (no AI), with Archive all (undoable), Always archive
    (adds a conditions-only rule) and Unsubscribe. Unsubscribe is done by DreyMail where the
    sender offers one-click (RFC 8058, https only); otherwise it opens their unsubscribe page.
  - Files: `server/src/ai/engine.ts`, `server/src/routes/assistant.ts`, `shared/assistant.ts`,
    `web/src/components/AssistantDialog.tsx`, `web/src/api.ts`, `web/src/styles.css`. Tests:
    `server/test/assistant.test.ts`, `server/test/auth.test.ts`.

## 2026-11-15 (v3.1): AI mailbox assistant (part 1)

- **AI mailbox assistant**, opened per mailbox from the sidebar. Rules are written in plain
  language, with optional exact conditions, and run on new mail before notifications. It adds
  **Test** against recent mail with "Do it", and **History** with undo. Actions happen on the mail
  server itself:
  - moves, with folders created when missing (`server/src/imap/pool.ts`, `server/src/app.ts`)
  - Gmail labels, or IMAP keywords, or copies into a folder
  - archive, read, star, Trash, spam
- **AI connections**, per user or shared by administrators, with mailbox checkboxes and a daily
  limit. Services:
  - Anthropic through its official SDK (new dependency `@anthropic-ai/sdk`)
  - Google Gemini
  - OpenAI-style APIs: OpenAI, DeepSeek, Mistral, Groq, OpenRouter, xAI
  - local servers: LM Studio, Ollama, vLLM, llama.cpp
  - Model suggestions steer toward inexpensive models.
- **Accuracy slider** per mailbox (Private to Full, default Full); holding it shows exactly what
  the AI sees.
- **At-your-own-risk notice** before first use.
- **Permissions:** `ai.assistant` (Use the AI mailbox assistant) and `ai.manage` (shared and local
  connections), plus a per-user on/off switch in Settings → Users. Local-network addresses are
  only for administrators.
- **Files:**
  - Server: new `server/src/ai/providers.ts`, `server/src/ai/store.ts`, `server/src/ai/engine.ts`,
    `server/src/routes/assistant.ts`; `server/src/db.ts` (tables, `users.ai_access`/`ai_terms_at`),
    `server/src/routes/admin.ts`.
  - Shared: new `shared/aiProviders.ts` and `shared/assistant.ts`; `shared/permissions.ts`,
    `shared/types.ts`.
  - Web: new `web/src/components/AssistantDialog.tsx` and `web/src/components/AiConnections.tsx`;
    `web/src/components/Sidebar.tsx`, `web/src/components/SettingsDialog.tsx`,
    `web/src/components/AdminSettings.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/styles.css`.
  - README: new section "AI mailbox assistant" with a guide to services, keys, models and local
    servers, linked from the app.
- Tests: `server/test/assistant.test.ts`.

## 2026-11-15 (docs): Roadmap brought up to date

- `ROADMAP.md` rewritten: what DreyMail already does (with the version it arrived in), what is
  planned (including the AI mailbox assistant) and what is not planned (JMAP, export).

## 2026-11-15 (v3.0): Your own picture as a mailbox icon

- Next to the 38 built-in icons, a mailbox can use **a picture you upload**: zoom (smaller or
  larger), drag it into place, and choose a transparent, white or black background. The browser
  makes the final 256px image (new `MailboxImageEditor`, picker changes in
  `web/src/components/MailboxIcon.tsx`, `web/src/components/AccountsDialog.tsx`). Choosing a
  built-in icon keeps the picture for later; it can be removed.
- Server: stored with the mailbox (`accounts.icon_image`, `server/src/db.ts`); `GET/PUT/DELETE
  /api/accounts/:id/icon` (checked image types, owner only, `mail.accounts` to change;
  `server/src/routes/api.ts`); `AccountView.iconImage` (`shared/types.ts`).
- Shown in the sidebar and account list. Notifications use it as the large icon:
  - Desktop app: `web/src/desktop.ts`, `web/src/App.tsx`.
  - Browsers: the service worker fetches it (`web/public/sw.js`, `server/src/push/*.ts`).
  - Android app: `web/src/android.ts`, `Notifier.kt`. Android's status-bar icon has to be a plain
    shape, so it stays the envelope there.
- Tests: `server/test/mailboxIcons.test.ts`.
- **Wording:** American spelling in the README, ROADMAP and app text (color, capitalized,
  organizing…), and the README now describes DreyMail for anyone rather than one person's
  accounts (`README.md`, `ROADMAP.md`, `web/src/components/SettingsDialog.tsx`,
  `web/src/components/AdminSettings.tsx`, `web/src/components/MailboxIcon.tsx`,
  `server/src/routes/microsoft.ts`, `server/src/routes/google.ts`, `CLAUDE.md`).

## 2026-11-15 (v2.9): Mailbox icons

- **An icon per mailbox** (38 to choose from, or the coloured dot as before), picked next to the
  colour in Accounts. It shows in the mailbox's colour in the sidebar and the account list.
  `accounts.icon` (`server/src/db.ts`), the `icon` field (`shared/types.ts`,
  `server/src/routes/api.ts`). New `shared/mailboxIcons.ts`, generated from Lucide icons (ISC
  licence, credited in the file) by the new `scripts/mailbox-icons.mjs`. New
  `web/src/components/MailboxIcon.tsx`; `web/src/components/AccountsDialog.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/styles.css`.
- **Notifications show it:** the icon on a tile in the mailbox colour.
  - **Desktop app:** `web/src/desktop.ts`, `web/src/App.tsx`.
  - **Browsers:** the push payload carries the colour and icon shape, and the service worker
    draws it where the browser can (`server/src/push/notify.ts`, `server/src/push/service.ts`,
    `web/public/sw.js`).
  - **Android app:** both the large icon and the status-bar icon (`web/src/android.ts`,
    `android/.../Notifier.kt`).
- Release workflow: the manual-release input asks for the full commit SHA.
- Tests: `server/test/mailboxIcons.test.ts`.

## 2026-11-15 (v2.8): Initials in the app colour; Node 24

- Without a profile photo, the round initials (first letter, or first and last) are filled with the
  current UI colour and change with it as you switch accounts (`web/src/styles.css`).
- **Node 24 everywhere:** the image is built on `node:24-alpine` (`Dockerfile`); `engines` asks for
  Node 24 (`package.json`, `package-lock.json`); CI and releases test on Node 24 and use the GitHub
  Actions versions that run on Node 24 (checkout, setup-node, setup-java v5, setup-gradle v5, docker
  setup-buildx/login v4, metadata v6, build-push v7) (`.github/workflows/ci.yml`,
  `.github/workflows/release.yml`). Unit and integration tests pass on Node 24.22.
- **Releases:** "already released" now means a GitHub Release exists (a missed version's tag can be
  pushed by hand first, since the workflow's token may not tag an older commit whose workflow files
  differ); the image's revision label names the commit actually built (`.github/workflows/release.yml`).

## 2026-11-15 (v2.7): Choose what the bottom left shows

- Settings → Profile → "Bottom left shows": photo and name (default), name only, or photo only;
  the collapsed sidebar always shows the photo. New `footerIdentity` preference (`shared/types.ts`,
  `server/src/db.ts`, `server/src/routes/api.ts`, `web/src/components/SettingsDialog.tsx`,
  `web/src/components/Sidebar.tsx`, `web/src/App.tsx`, `web/src/styles.css`).
- **Releases:** runs now queue per version, so a quick push of the next version no longer drops
  the previous version's release (2.6 lost its run that way). `latest` only goes to the version
  main carries. A missed version can be released by hand with its commit
  (`.github/workflows/release.yml`).

## 2026-11-15 (v2.6): Collapsed sidebar shows only your picture

_No GitHub Release: the run for 2.6 was dropped when 2.7 was pushed right after it (fixed in 2.7:
runs now queue per version). Everything in 2.6 is in 2.7 and later._

- With the sidebar collapsed, its footer shows only your profile picture, which opens Settings.
  Accounts, Settings and Sign out are back when it's expanded (`web/src/styles.css`).
- Saved searches made in the same millisecond keep their order (`server/src/db.ts`; fixes an
  intermittent test failure).

## 2026-11-15 (v2.5): Roles and permissions, profile pictures, grouped settings

- **Roles with permission flags** replace the administrator yes/no.
  - Superadmin has every right, including future ones. User is the default for new users.
  - Custom roles can have any flags. No one can grant rights they lack, and only a Superadmin can
    change a Superadmin.
  - Files: new `shared/permissions.ts` and `server/src/access.ts`; `roles` table, `users.role_id`
    and an upgrade that makes existing administrators Superadmins (`server/src/db.ts`).
  - Every administrative route checks its own flag (`server/src/routes/admin.ts`,
    `server/src/routes/microsoft.ts`, `server/src/routes/google.ts`, `server/src/routes/api.ts`),
    and mailbox changes need `mail.accounts`. `Me` carries the role and its permissions; `AdminUser`
    has `roleId` (`shared/types.ts`).
- **Profile pictures**, with flags for your own and for anyone's.
  - The browser crops and scales the picture (new `web/src/components/UserPicture.tsx`), and the
    server checks the image and stores it (new `server/src/profilePicture.ts`, `users.avatar`).
  - Without a picture: your Gravatar, fetched by the server (can be turned off), or your initials.
  - Shown in the sidebar footer and in Settings → Users.
- **Settings tabs grouped** under This device, Your account and Administration, wrapping instead
  of scrolling out of sight. Changes:
  - New Profile tab (picture, name, role).
  - New Roles tab; Users tab with role pickers and picture editing
    (`web/src/components/AdminSettings.tsx`, `web/src/components/SettingsDialog.tsx`).
- **No mailboxes yet:** the list says "Add a mailbox to get started" with an Add mailbox button (or
  explains that the role doesn't allow it) instead of an empty "All inboxes"
  (`web/src/components/MessageList.tsx`, `web/src/App.tsx`).
- **Mailboxes dialog** hides adding and editing when the role doesn't allow it
  (`web/src/components/AccountsDialog.tsx`).
- **Sidebar footer:** a small picture next to your name, which opens Settings; the collapse arrow
  moved next to the logo (`web/src/components/Sidebar.tsx`, `web/src/styles.css`, `web/src/api.ts`).
- Tests: `server/test/admin.test.ts` (roles, escalation, pictures, upgrade), `web/test/sidebar.test.ts`.

## 2026-11-15 (v2.4): Search filters and saved searches

- **Filter builder** (no query syntax): where to look (this folder, all inboxes, all mail), accounts,
  from, to, subject, message text, date (presets or a range), size, has attachment, starred,
  replied to. New `shared/search.ts` (filter model, validation, date ranges, chips) used by both
  sides; IMAP SEARCH criteria and the "all mail" folder choice in `server/src/imap/mail.ts`
  (attachments: Gmail's own search first, then `multipart/mixed`); `/api/messages` takes `filter`
  (`server/src/routes/api.ts`).
- **Saved searches** as sidebar smart folders: `saved_searches` table and store methods
  (`server/src/db.ts`), `/api/searches` (`server/src/routes/api.ts`).
- **Web:** new `web/src/components/SearchPanel.tsx`; filter button, chips and Save search in
  `web/src/components/MessageList.tsx`; saved searches in `web/src/components/Sidebar.tsx`; filters
  and messages opened from another folder in the URL (`web/src/routing.ts`); `web/src/App.tsx`,
  `web/src/api.ts`, `web/src/hooks.ts`, `web/src/styles.css`. Tests: `server/test/searchFilters.test.ts`,
  `web/test/routing.test.ts`, `web/test/sidebar.test.ts`.

## 2026-11-15 (v2.3): Gmail with Sign in with Google

- **Sign in with Google** as a second way to add Gmail (app passwords keep working): new
  `server/src/oauth/google.ts` (authorization code + PKCE, `https://mail.google.com/` scope,
  offline access; refresh token encrypted) and `server/src/routes/google.ts` (start, callback,
  admin); `DREYMAIL_GOOGLE_CLIENT_ID` / `_SECRET` override (`server/src/config.ts`). Google-signed-in
  accounts use IMAP and SMTP with OAuth (`createSmtpTransport` token, `server/src/imap/connect.ts`;
  `server/src/mail/send.ts`); `Store.saveGoogleAccount` and a shared `saveOAuthAccount`
  (`server/src/db.ts`); `AccountAuth` gains `google` (`shared/types.ts`); wiring in `server/src/app.ts`.
- **Web:** Add account offers "Gmail: Sign in with Google" next to "Gmail (app password) or other
  email"; Google accounts share the Outlook edit/reconnect screen; Settings → Google for
  administrators with the Google Cloud walkthrough (`web/src/components/AccountsDialog.tsx`,
  `web/src/components/AdminSettings.tsx`, `web/src/components/SettingsDialog.tsx`, `web/src/main.tsx`,
  `web/src/App.tsx`, `web/src/api.ts`, `web/src/styles.css`). Tests: `server/test/google.test.ts`.

## 2026-11-15 (v2.2): Outlook and Microsoft 365, "This device" settings

- **Outlook / Microsoft 365 accounts** with Microsoft sign-in (OAuth 2.0 authorization code +
  PKCE), new `server/src/oauth/microsoft.ts`: app registration in Settings → Outlook (client
  secret encrypted; `DREYMAIL_MICROSOFT_CLIENT_ID`, `_CLIENT_SECRET`, `_TENANT` override,
  `server/src/config.ts`); access tokens per resource, cached and refreshed, refresh tokens
  rotated and stored encrypted (`accounts.auth`, `accounts.oauth_token`, `Store.saveMicrosoftAccount`
  in `server/src/db.ts`). IMAP logs in with the token (`setOAuthTokenProvider` in
  `server/src/imap/connect.ts`); sending goes through Microsoft Graph with the complete MIME message
  (Bcc kept for Graph, Sent copy by Microsoft; `server/src/mail/send.ts`). Routes: new
  `server/src/routes/microsoft.ts` (start, callback, admin); Outlook accounts only allow label/name/
  colour edits (`server/src/routes/api.ts`). Wiring in `server/src/app.ts`; types in `shared/types.ts`.
  Tests: `server/test/microsoft.test.ts`.
- **Web:** Add account first asks "Outlook / Microsoft 365" or "Gmail or other email"; Outlook
  accounts get their own edit screen with Reconnect (`web/src/components/AccountsDialog.tsx`); the
  result of signing in is announced when you come back (`web/src/main.tsx`, `web/src/App.tsx`);
  Settings → Outlook for administrators (`web/src/components/AdminSettings.tsx`).
- **Settings → This device** (first tab): which client and version, updates, change server (now
  also in the desktop app: `desktop/main.cjs`, `desktop/preload.cjs`, `web/src/desktop.ts`), interface
  size, this device's notifications and email links. The Notifications tab moved into it
  (`web/src/components/SettingsDialog.tsx`, `web/src/styles.css`).
- **Notice fix:** seven files written for DreyMail (`desktop/main.cjs`, `desktop/preload.cjs`,
  `server/src/routes/admin.ts`, `web/src/components/AdminSettings.tsx`, `web/src/desktop.ts`, two
  tests) had wrongly been given the "modified version of Ratatoskr" file notice; they now carry
  DreyMail's own header, as they contain no upstream code.

## 2026-11-15 (docs, ships with v2.2): which mail providers work

- README: new "Which mail providers work" section. Outlook.com/Hotmail/Live and Microsoft 365
  can't be added yet (Microsoft requires OAuth sign-in); Gmail, iCloud and Yahoo work with app
  passwords. Microsoft OAuth added to `ROADMAP.md` as high priority.

## 2026-11-14 (v2.1): version, update dot and changelog at the bottom left

- Bottom left shows the first name only (new preference `showFullName`, Settings → General) and
  the server version; the version opens "What's new" (new `web/src/components/ChangelogDialog.tsx`,
  a small renderer for this file, which now ships in the image: `Dockerfile`).
- Update notice for administrators: new `server/src/version.ts` checks GitHub's latest release at
  most every 6 hours (`DREYMAIL_UPDATE_CHECK=false` turns it off, `server/src/config.ts`);
  `GET /api/version` and `GET /api/changelog` (`server/src/routes/api.ts`, `server/src/app.ts`,
  `shared/types.ts`). A blinking dot on the version when a newer image exists
  (`web/src/components/Sidebar.tsx`, `web/src/styles.css`, `web/src/App.tsx`, `web/src/api.ts`).
- Tests: `server/test/version.test.ts`, `web/test/changelog.test.ts`, `web/test/sidebar.test.ts`.

## 2026-11-13 (v2.0): tablets and foldables, interface size, your name, in-app Android updates

- **Layouts:** three tiers (`web/src/styles.css`, `web/src/App.tsx`, `web/src/components/Reader.tsx`):
  phones (≤ 640 px) one pane at a time; tablets and unfolded foldables (641–1024 px) message list
  left, message right, folders in a slide-in drawer with a backdrop; desktops three columns. A
  narrow message pane gets the compact sender header (container query).
- **Interface size** per device (new `web/src/uiScale.ts`; `web/src/main.tsx`, Settings →
  General): Automatic is 115 % in the Android app times the phone's font scale, 110 % on touch
  phones, 100 % elsewhere; viewport-sized lengths are divided by `--ui-zoom`.
- **Your name:** `users.display_name` (not overwritten by OIDC), `PUT /api/me/name` with
  capitalisation of lower-case input, `Me.displayName`; shown bottom-left, falling back to the
  login name with a capital letter (`server/src/db.ts`, `server/src/routes/api.ts`,
  `shared/types.ts`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/components/SettingsDialog.tsx`).
  Tests: `server/test/name.test.ts`.
- **Android:** in-app updates (download with Android's download manager, then the install screen;
  asks for the install permission once), re-check when the app comes back after 6 hours; the
  bridge reports the phone's font scale (`android/.../Updater.kt`, `MainActivity.kt`,
  `AndroidManifest.xml`).

## 2026-11-13 (v1.9): first release with the Android app attached

- The repository's Android signing secrets are set, so the Release workflow now builds and
  attaches `DreyMail-1.9.apk` (signed) next to the desktop apps. No code changes.

## 2026-11-13 (v1.8): Android app

- **Android app** (new `android/`: Kotlin, WebView around the user's DreyMail server):
  `MainActivity.kt` (WebView, file uploads, attachment downloads, mailto: handling, bridge
  `window.DreyMailAndroid`), `PushService.kt` (Firebase messages), `Notifier.kt` (one Android
  notification channel per account so each has its own sound/vibration; status-bar icon tinted
  and large icon drawn in the account colour; grouping; clearing), `WebPushCrypto.kt`
  (decrypts RFC 8291 messages), `Updater.kt` (GitHub release check), `Server.kt`, `Prefs.kt`,
  `DreyMailApp.kt`; launcher and notification icons (`scripts/icons.mjs`).
- **Server:** Firebase Cloud Messaging HTTP v1 sender without an SDK (new `server/src/push/fcm.ts`:
  service-account JWT, data-only messages encrypted end to end with the phone's keys, dead tokens
  dropped). Every Web Push notification and clear also goes to the user's phones
  (`server/src/push/service.ts`). New `fcm_tokens` table (`server/src/db.ts`), phone registration
  `/api/push/android` (new `server/src/routes/android.ts`), Firebase settings in Settings → Android
  with `DREYMAIL_FIREBASE_*` environment overrides (`server/src/routes/admin.ts`,
  `server/src/config.ts`, `server/src/app.ts`). Tests: `server/test/fcm.test.ts`.
- **Web app:** Android bridge (new `web/src/android.ts`): registers the phone, keeps channels in
  step with accounts; Settings → Notifications lists per-account sound settings in the app;
  Settings → General shows the app version, update check and server change
  (`web/src/App.tsx`, `web/src/api.ts`, `web/src/components/SettingsDialog.tsx`,
  `web/src/components/AdminSettings.tsx`, `web/src/styles.css`).
- **Builds:** CI compiles the app on branches (`.github/workflows/ci.yml`); the Release workflow
  builds `DreyMail-X.Y.apk` signed with the key in the repository secrets and attaches it
  (`.github/workflows/release.yml`). `.gitignore` keeps build output and keystores out.

## 2026-11-13 (v1.7): desktop apps for Linux and Windows

- **Desktop app** (new `desktop/`: Electron shell `main.cjs`, `preload.cjs`, first-run
  `setup.html`, packaging `electron-builder.yml`): DreyMail in its own window, tray icon (closing
  keeps it running), menu (change server, check for updates, source code, about). Only the
  server's pages may use the bridge; links in mail open in the browser.
- **Colour-coded notifications:** the server now also sends each new-mail and snooze-ended
  notification to open sessions (`notify` event; `server/src/app.ts`, `shared/types.ts`). Desktop
  sessions ask for new-mail checks even without Web Push (`ImapPool.setLiveNotify` in
  `server/src/imap/pool.ts`, `server/src/routes/ws.ts`). The web app shows them through the
  desktop bridge with the envelope drawn in the account colour (new `web/src/desktop.ts`;
  `web/src/App.tsx`, `web/src/hooks.ts`).
- **Updater** (`desktop/update.cjs`, tested in `web/test/desktopUpdate.test.ts`): checks the latest
  GitHub release on every start and on demand; detects flatpak / deb / rpm / Windows installs
  and gives the exact upgrade (command copied, download opened; Windows downloads and runs the
  installer). Settings → General shows the desktop version with "Check for updates".
- **Builds:** the Release workflow builds `DreyMail-X.Y-amd64.deb`, `DreyMail-X.Y-x86_64.rpm`,
  `DreyMail-X.Y-x86_64.flatpak` and `DreyMail-Setup-X.Y-x64.exe` and attaches them to the GitHub
  Release (`.github/workflows/release.yml`). The Docker image leaves `desktop/` out
  (`.dockerignore`).
- **Fix (upstream bug):** after signing in, the account list could stay empty until a reload; it
  was asked for before sign-in and not again after (`web/src/components/Login.tsx`,
  `web/src/App.tsx`, `web/src/hooks.ts`).

## 2026-11-13 (v1.6): spacing and element clean-up

From a screenshot pass on desktop and phone, light and dark:

- Reader: the account shows as one small tag (dot + name) instead of a dot followed by "· name"
  (`web/src/components/Reader.tsx`, `web/test/reader.test.ts`).
- Phones: a floating Compose button on the message list; before, Compose was only in the folder
  drawer (`web/src/components/MessageList.tsx`, `web/src/App.tsx`).
- Account editor: the Security column no longer cuts off "None (insecure)"; "Color" spelling
  (`web/src/components/AccountsDialog.tsx`).
- Settings: taller Appearance switch, single dropdowns no wider than they need to be, "Screen
  transitions" capitalisation (`web/src/components/SettingsDialog.tsx`, `web/src/styles.css`).

## 2026-11-13 (v1.5): DreyMail's own names everywhere

The project now uses its own identity in code, configuration and data; the upstream name remains
only in the required attribution (NOTICE, README Credits, file-header notices, this history).

- **Environment variables:** every `RATATOSKR_*` variable is now `DREYMAIL_*`
  (`server/src/config.ts`, `web/vite.config.ts`, `shared/devHosts.ts`, `scripts/devEnv.mjs`,
  `Dockerfile`, `docker/entrypoint.sh`, `.env.example`, `docker-compose.yml`, README, tests). The
  old names stop the server with a message naming each replacement.
- **Data:** database file `dreymail.db`; key-derivation salt `dreymail` (`server/src/crypto.ts`);
  session cookies `dm_session`/`dm_login` (`server/src/auth/session.ts`); CSRF header
  `x-dreymail` (`web/src/api.ts`, `web/public/sw.js`, `server/src/routes/api.ts`,
  `server/src/auth/routes.ts`); cache label; localStorage key (`web/src/mailto.ts`).
- **One-time upgrade:** new `server/src/upgrade.ts` renames the old database file, drops the mail
  cache, re-encrypts stored secrets with the new keys (`Store.rekeyFrom` in `server/src/db.ts`,
  `Keyring` salt parameter) and rejects old variable names (`server/src/app.ts`,
  `server/src/config.ts`). Tests: `server/test/upgrade.test.ts`.
- **Outgoing identifiers:** `X-Mailer: DreyMail`, IMAP client ID `DreyMail`, image fetcher
  User-Agent (`server/src/mail/compose.ts`, `server/src/imap/connect.ts`,
  `server/src/net/remoteImages.ts`); container entrypoint `dreymail-entrypoint`.
- Comments, test names and docs across the code base (`CLAUDE.md` rules updated).

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
