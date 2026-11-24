// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The loading screen (DreyMail 13.8) is in index.html, so it shows the moment the page arrives.
// The app takes it away once there is something to show: the sign-in page, or your mail.

let done = false;

export function hideSplash() {
  if (done) return;
  done = true;
  const el = document.getElementById('splash');
  if (!el) return;
  el.classList.add('gone');
  window.setTimeout(() => el.remove(), 300);
}

/** A word under the icon while it takes long (a server waking up, a slow connection). */
export function splashText(text: string) {
  const el = document.getElementById('splash-text');
  if (el && !done) el.textContent = text;
}
