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
