// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-16: the frame takes its message's full height, so a
// conversation scrolls as one page instead of a scroll box per message.
// Modified by samschultzponsys, 2026-11-21: wide messages wrap, then shrink to fit.

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
    // The page scrolls, not the frame.
    doc.documentElement.style.overflowY = 'hidden';
    let zoom = 1;
    let lastWidth = -1;
    const widened: [HTMLElement, string, string][] = [];
    // Wider than the frame (a fixed-width ticket or newsletter on a phone) (DreyMail 11.8): first let
    // fixed widths give way so text wraps; if it is still too wide, shrink it to fit.
    const fitWidth = () => {
      const de = doc.documentElement;
      const avail = de.clientWidth;
      if (!avail || avail === lastWidth) return;
      lastWidth = avail;
      de.classList.remove('dm-reflow');
      for (const [el, value, priority] of widened.splice(0)) el.style.setProperty('width', value, priority);
      doc.body.style.removeProperty('zoom');
      zoom = 1;
      if (de.scrollWidth <= avail + 2) return;
      de.classList.add('dm-reflow');
      // Only what is too wide gives way: a table fills the width, anything else sizes to its content.
      const els = doc.body.querySelectorAll<HTMLElement>('table, td, th, div, p, center, span, a, img, section, article');
      for (let i = 0; i < els.length && i < 4000; i++) {
        const el = els[i]!;
        if (el.getBoundingClientRect().width <= avail + 1) continue;
        widened.push([el, el.style.getPropertyValue('width'), el.style.getPropertyPriority('width')]);
        el.style.setProperty('width', el.tagName === 'TABLE' ? '100%' : el.tagName === 'IMG' ? '100%' : 'auto', 'important');
      }
      if (de.scrollWidth <= avail + 2) return;
      zoom = Math.max(0.4, avail / de.scrollWidth);
      doc.body.style.setProperty('zoom', String(zoom));
    };
    const fit = () => {
      fitWidth();
      const body = doc.body;
      const style = doc.defaultView?.getComputedStyle(body);
      const margins = style ? Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom) : 0;
      // The content's own height (not the frame's), so the frame can shrink as well as grow; shrunk
      // to fit, the box's on-screen height.
      const h = zoom < 1 ? body.getBoundingClientRect().height : Math.max(body.scrollHeight, body.getBoundingClientRect().height);
      setHeight(Math.ceil(h + margins) + 2);
    };
    fit();
    watcher.current = new ResizeObserver(fit);
    watcher.current.observe(doc.body);
    // The frame narrower or wider (phone turned, pane resized): fit again.
    if (frame.current) watcher.current.observe(frame.current);
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
