// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-16: the frame takes its message's full height, so a
// conversation scrolls as one page instead of a scroll box per message.

import { useEffect, useMemo, useRef, useState } from 'react';
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
 *
 * The frame is as tall as its message (DreyMail), so a conversation reads as one page. Measuring
 * that needs `allow-same-origin`; scripts stay off (no `allow-scripts`), so nothing in the message
 * can run or reach the app, and the CSP inside still blocks every request.
 */
export function MessageFrame({ html, css, mode, themeKey }: { html: string; css: string; mode: RenderMode; themeKey: string }) {
  const srcDoc = useMemo(
    () => buildSrcdoc({ html: rewriteMailtoLinks(html, globalThis.location?.origin ?? ''), css, mode, palette: palette() }),
    // themeKey forces a rebuild when the app theme changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, css, mode, themeKey],
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const watcher = useRef<ResizeObserver | null>(null);
  useEffect(() => () => watcher.current?.disconnect(), []);

  const measure = () => {
    watcher.current?.disconnect();
    const doc = frame.current?.contentDocument;
    if (!doc?.body) return;
    // The page scrolls, not the frame; wide mail (a newsletter on a phone) can still scroll sideways.
    doc.documentElement.style.overflowY = 'hidden';
    const fit = () => {
      const body = doc.body;
      const style = doc.defaultView?.getComputedStyle(body);
      const margins = style ? Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom) : 0;
      // The content's own height (not the frame's), so the frame can shrink as well as grow.
      setHeight(Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height) + margins) + 2);
    };
    fit();
    watcher.current = new ResizeObserver(fit);
    watcher.current.observe(doc.body);
  };

  return (
    <iframe
      ref={frame}
      className="msg-frame"
      title="Message content"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={measure}
      style={height ? { height } : undefined}
    />
  );
}
