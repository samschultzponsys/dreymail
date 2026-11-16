// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Links in DreyMail's own pages (a signature's preview, text you're writing, a hint) must never
// replace the app: in the desktop and Android apps the window would show that site with no way
// back. Links to other sites open in a new window (the browser, from the apps); links inside text
// being edited don't open at all. Mail itself shows in a sandboxed frame with its own rules.

/** What a click on a link should do. */
export function linkAction(href: string, appOrigin: string, inEditor: boolean): 'app' | 'new-window' | 'nothing' {
  if (inEditor) return 'nothing';
  let url: URL;
  try {
    url = new URL(href, appOrigin);
  } catch {
    return 'nothing';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'app'; // mailto:, tel:: the system handles them
  return url.origin === appOrigin ? 'app' : 'new-window';
}

/** Watches clicks on links anywhere in the app (capture phase, before anything else sees them). */
export function guardLinks(doc: Document = document) {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || (e.type === 'click' && e.button !== 0) || (e.type === 'auxclick' && e.button !== 1)) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    const action = linkAction(a.getAttribute('href') ?? '', doc.location.origin, a.isContentEditable);
    if (action === 'app') return;
    e.preventDefault();
    if (action === 'new-window') window.open(a.href, '_blank', 'noopener,noreferrer');
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onClick, true);
}
