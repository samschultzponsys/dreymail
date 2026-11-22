// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Folders pinned to the bar above the message list (DreyMail 12.1): one tap away, in the order
// you drag them into. Mouse: drag a chip; touch: hold a chip, then drag. Holding a chip and letting
// go without moving shows the × buttons to remove chips (Done ends it).

import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface TopFolderItem {
  key: string;
  label: string;
  /** The mailbox's color, shown when the bar has folders of more than one mailbox. */
  color: string | null;
  unread: number;
  active: boolean;
}

/** Moves `key` to `index` in `keys`. */
export function moveKey(keys: string[], key: string, index: number): string[] {
  const rest = keys.filter((k) => k !== key);
  const i = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, i), key, ...rest.slice(i)];
}

const HOLD_MS = 350;

export function TopFolderBar({ items, onOpen, onReorder, onRemove }: { items: TopFolderItem[]; onOpen: (key: string) => void; onReorder: (keys: string[]) => void; onRemove: (key: string) => void }) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ key: string; x: number; y: number; id: number; touch: boolean; timer: number | null; moved: boolean; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const keys = order ?? items.map((i) => i.key);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const shown = keys.map((k) => byKey.get(k)).filter((x): x is TopFolderItem => !!x);

  useEffect(() => {
    if (!editing) return;
    const end = (e: PointerEvent) => {
      if (bar.current && !bar.current.contains(e.target as Node)) setEditing(false);
    };
    document.addEventListener('pointerdown', end);
    return () => document.removeEventListener('pointerdown', end);
  }, [editing]);

  const startDrag = (key: string) => {
    if (!gesture.current) return;
    gesture.current.dragging = true;
    setDragging(key);
    setOrder(items.map((i) => i.key));
  };
  /** The chip nearest the pointer: where the dragged one goes. */
  const targetIndex = (x: number, y: number): number => {
    const chips = [...(bar.current?.querySelectorAll<HTMLElement>('[data-chip]') ?? [])];
    let best = 0;
    let bestD = Infinity;
    chips.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(x - (r.left + r.width / 2), (y - (r.top + r.height / 2)) * 2);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  const finish = (commit: boolean) => {
    const g = gesture.current;
    if (g?.timer) clearTimeout(g.timer);
    if (g?.dragging) {
      suppressClick.current = true;
      if (commit && order && order.join('\u0000') !== items.map((i) => i.key).join('\u0000')) onReorder(order);
      // Held and let go without moving (touch): show the × buttons.
      else if (g.touch && !g.moved) setEditing(true);
    }
    gesture.current = null;
    setDragging(null);
    setOrder(null);
  };

  if (!shown.length) return null;
  return (
    <div className={`top-folders ${editing ? 'editing' : ''}`} ref={bar} role="toolbar" aria-label="Pinned folders">
      {shown.map((it) => (
        <span key={it.key} className={`top-folder ${it.active ? 'on' : ''} ${dragging === it.key ? 'dragging' : ''}`} data-chip>
          <button
            className="top-folder-btn"
            aria-current={it.active ? 'page' : undefined}
            title={`${it.label} (drag to move)`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              const touch = e.pointerType !== 'mouse';
              const g = { key: it.key, x: e.clientX, y: e.clientY, id: e.pointerId, touch, timer: null as number | null, moved: false, dragging: false };
              gesture.current = g;
              if (touch) g.timer = window.setTimeout(() => startDrag(it.key), HOLD_MS);
            }}
            onPointerMove={(e) => {
              const g = gesture.current;
              if (!g || g.id !== e.pointerId) return;
              const far = Math.hypot(e.clientX - g.x, e.clientY - g.y) > 6;
              if (!g.dragging) {
                if (!far) return;
                // Touch moving before the hold: it's a scroll, not a drag.
                if (g.touch) return finish(false);
                startDrag(g.key);
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }
              if (far) g.moved = true;
              e.preventDefault();
              const i = targetIndex(e.clientX, e.clientY);
              setOrder((cur) => {
                const now = cur ?? items.map((x) => x.key);
                return now.indexOf(g.key) === i ? now : moveKey(now, g.key, i);
              });
            }}
            onPointerUp={() => finish(true)}
            onPointerCancel={() => finish(false)}
            onContextMenu={(e) => {
              // Touch: the hold is ours (to drag), not the browser's menu.
              if (gesture.current?.touch) e.preventDefault();
            }}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              if (!editing) onOpen(it.key);
            }}
          >
            {it.color && <span className="dot" style={{ background: it.color }} aria-hidden="true" />}
            <span className="top-folder-name">{it.label}</span>
            {it.unread > 0 && <span className="count">{it.unread}</span>}
          </button>
          <button className="top-folder-x" title={`Remove ${it.label} from this bar`} aria-label={`Remove ${it.label} from this bar`} onClick={() => onRemove(it.key)}>
            <X size={12} />
          </button>
        </span>
      ))}
      {editing && (
        <button className="chip top-folders-done" onClick={() => setEditing(false)}>
          Done
        </button>
      )}
    </div>
  );
}
