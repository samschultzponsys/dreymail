// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// A mailbox's icon (shared/mailboxIcons.ts) in its colour, or a picture the user uploaded, and the
// picker and picture editor for it.

import { ImagePlus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MAILBOX_ICONS } from '../../../shared/mailboxIcons';
import type { AccountView } from '../../../shared/types';
import { api } from '../api';

/** The mailbox icon in its colour, its uploaded picture, or the coloured dot for a mailbox without one. */
export function MailboxIcon({ icon, color, size = 14, image }: { icon: string; color: string; size?: number; image?: string | null }) {
  if (icon === 'image' && image) return <img className="mailbox-icon mailbox-image" src={image} width={size} height={size} alt="" />;
  const path = MAILBOX_ICONS[icon]?.path;
  if (!path) return <span className="dot" style={{ background: color }} aria-hidden="true" />;
  return (
    <svg className="mailbox-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

type Background = 'transparent' | 'white' | 'black';
const OUT = 256;

/**
 * Upload a picture as a mailbox icon: zoom (smaller or larger), drag it into place, and put it on a
 * transparent, white or black background. The browser makes the final 256px image.
 */
export function MailboxImageEditor({ onSave, onCancel, busy }: { onSave: (dataUrl: string) => void; onCancel: () => void; busy?: boolean }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [bg, setBg] = useState<Background>('transparent');
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => file.current?.click(), []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, OUT, OUT);
    if (bg !== 'transparent') {
      g.fillStyle = bg === 'white' ? '#ffffff' : '#000000';
      g.fillRect(0, 0, OUT, OUT);
    }
    // At zoom 1 the whole picture fits; zoom in to crop, out to leave room around it.
    const scale = Math.min(OUT / img.naturalWidth, OUT / img.naturalHeight) * zoom;
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (OUT - w) / 2 + offset.x, (OUT - h) / 2 + offset.y, w, h);
  }, [img, zoom, offset, bg]);

  const load = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) return setError('Choose a picture file');
    const i = new Image();
    i.onload = () => {
      setImg(i);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setError(null);
    };
    i.onerror = () => setError("That picture can't be opened");
    i.src = URL.createObjectURL(f);
  };

  const save = () => {
    const c = canvas.current;
    if (!c) return;
    // WebP keeps transparency and stays small; PNG where the browser can't make WebP.
    const webp = c.toDataURL('image/webp', 0.9);
    onSave(webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png'));
  };

  const down = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const k = OUT / 140;
    setOffset({ x: d.ox + (e.clientX - d.x) * k, y: d.oy + (e.clientY - d.y) * k });
  };

  return (
    <div className="picture-editor">
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={(e) => load(e.target.files?.[0])} />
      {img ? (
        <>
          <canvas
            ref={canvas}
            width={OUT}
            height={OUT}
            className={`mailbox-crop bg-${bg}`}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={() => (drag.current = null)}
            aria-label="Drag to move the picture"
          />
          <label className="picture-zoom">
            <span>Size</span>
            <input type="range" min={0.3} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          </label>
          <div className="segmented" role="radiogroup" aria-label="Background">
            {(['transparent', 'white', 'black'] as const).map((b) => (
              <button key={b} type="button" role="radio" aria-checked={bg === b} className={bg === b ? 'on' : ''} onClick={() => setBg(b)}>
                {b === 'transparent' ? 'Transparent' : b === 'white' ? 'White' : 'Black'}
              </button>
            ))}
          </div>
          <div className="hint">Drag to place it. Shown small, so a simple logo or picture works best.</div>
        </>
      ) : (
        <button type="button" className="btn" onClick={() => file.current?.click()}>
          <ImagePlus size={15} /> Choose a picture
        </button>
      )}
      {error && <div className="error-text">{error}</div>}
      <div className="row-buttons">
        {img && (
          <button type="button" className="btn" onClick={() => file.current?.click()}>
            Another picture
          </button>
        )}
        <span className="grow" />
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!img || busy} onClick={save}>
          Use picture
        </button>
      </div>
    </div>
  );
}

/**
 * Pick an icon (or none, or an uploaded picture) for a mailbox. Pictures need the mailbox to exist,
 * so `accountId` is null while adding one.
 */
export function MailboxIconPicker({
  value,
  color,
  onChange,
  accountId = null,
  image = null,
  onAccount,
}: {
  value: string;
  color: string;
  onChange: (icon: string) => void;
  accountId?: string | null;
  image?: string | null;
  /** The mailbox after its picture changed. */
  onAccount?: (a: AccountView) => void;
}) {
  const [open, setOpen] = useState(!!value);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<AccountView | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      const a = await fn();
      if (a) {
        onAccount?.(a);
        onChange(a.icon);
      }
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="label">Icon</label>
      {open ? (
        <div className="icon-grid" role="radiogroup" aria-label="Mailbox icon">
          <button type="button" role="radio" aria-checked={!value} className={`icon-choice ${!value ? 'on' : ''}`} title="No icon (colored dot)" onClick={() => onChange('')}>
            <span className="dot" style={{ background: color }} />
          </button>
          {image && (
            <button type="button" role="radio" aria-checked={value === 'image'} className={`icon-choice ${value === 'image' ? 'on' : ''}`} title="Your picture" onClick={() => onChange('image')}>
              <MailboxIcon icon="image" image={image} color={color} size={22} />
            </button>
          )}
          {Object.entries(MAILBOX_ICONS).map(([key, { label }]) => (
            <button type="button" key={key} role="radio" aria-checked={value === key} className={`icon-choice ${value === key ? 'on' : ''}`} title={label} aria-label={label} onClick={() => onChange(key)}>
              <MailboxIcon icon={key} color={color} size={18} />
            </button>
          ))}
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          <MailboxIcon icon="" color={color} /> Choose an icon
        </button>
      )}
      {open && (
        <div className="row-buttons" style={{ marginTop: 8 }}>
          {accountId ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
                <ImagePlus size={15} /> {image ? 'Upload another picture' : 'Upload a picture'}
              </button>
              {image && (
                <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.deleteAccountIcon(accountId))}>
                  <Trash2 size={15} /> Remove picture
                </button>
              )}
            </>
          ) : (
            <span className="hint">To use your own picture, save the mailbox first, then edit it.</span>
          )}
        </div>
      )}
      {editing && accountId && <MailboxImageEditor busy={busy} onCancel={() => setEditing(false)} onSave={(d) => void run(() => api.setAccountIcon(accountId, d))} />}
      {error && <div className="error-text">{error}</div>}
      <div className="hint">Shown in the sidebar and on this mailbox's notifications (desktop app, Android app and browsers that can draw it).</div>
    </div>
  );
}
