// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).

import { useMemo } from 'react';
import { buildSrcdoc, type RenderMode, type RenderPalette } from '../../../shared/srcdoc';
import { rewriteMailtoLinks } from '../mailto';

function palette(): RenderPalette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return { background: v('--message-bg'), text: v('--text'), muted: v('--muted'), link: v('--link'), border: v('--border-strong') };
}

/**
 * Renders sanitized message HTML in a sandboxed iframe: no scripts, opaque origin (no access to
 * the app, its cookies or storage), no forms, no top navigation. Links open in a new tab
 * (allow-popups) without an opener. Clicks inside the scriptless frame can't be caught, so mailto:
 * links instead point at DreyMail's own composer (in a new tab). A CSP inside the document blocks
 * every network request; remote images, when allowed, arrive already inlined as data: URIs.
 */
export function MessageFrame({ html, css, mode, themeKey }: { html: string; css: string; mode: RenderMode; themeKey: string }) {
  const srcDoc = useMemo(
    () => buildSrcdoc({ html: rewriteMailtoLinks(html, globalThis.location?.origin ?? ''), css, mode, palette: palette() }),
    // themeKey forces a rebuild when the app theme changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, css, mode, themeKey],
  );
  return (
    <iframe
      className="msg-frame"
      title="Message content"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
    />
  );
}
