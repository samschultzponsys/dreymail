// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Round profile pictures: the uploaded picture, else the user's Gravatar (the server fetches it),
// else their initials. The editor crops and scales in the browser, so the server only ever gets a
// small square image.

import { useQueryClient } from '@tanstack/react-query';
import { Camera, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Me } from '../../../shared/types';
import { api } from '../api';

export function nameInitials(name: string): string {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
}

export function UserAvatar({ src, name, size = 28 }: { src: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (src && !failed) return <img className="user-avatar" src={src} alt="" style={style} onError={() => setFailed(true)} />;
  return (
    <span className="user-avatar initials" style={style} aria-hidden="true">
      {nameInitials(name)}
    </span>
  );
}

const OUT = 256;

/** Pick a picture, then drag and zoom it inside the circle. Resolves with a data: URL. */
export function PictureEditor({ onSave, onCancel, busy }: { onSave: (dataUrl: string) => void; onCancel: () => void; busy?: boolean }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => file.current?.click(), []);

  // Draw the current crop: the picture covers the square, zoomed and moved by the user.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const ctx = c.getContext('2d')!;
    const scale = Math.max(OUT / img.naturalWidth, OUT / img.naturalHeight) * zoom;
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    // Keep the square covered whatever the offset.
    const ox = Math.min(0, Math.max(OUT - w, (OUT - w) / 2 + offset.x));
    const oy = Math.min(0, Math.max(OUT - h, (OUT - h) / 2 + offset.y));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUT, OUT);
    ctx.drawImage(img, ox, oy, w, h);
  }, [img, zoom, offset]);

  const load = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) return setError('Choose a picture file');
    const url = URL.createObjectURL(f);
    const i = new Image();
    i.onload = () => {
      setImg(i);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setError(null);
    };
    i.onerror = () => setError("That picture can't be opened");
    i.src = url;
  };

  const save = () => {
    const c = canvas.current;
    if (!c) return;
    const webp = c.toDataURL('image/webp', 0.86);
    onSave(webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.88));
  };

  const down = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // The preview is shown at 160px for a 256px picture.
    const k = OUT / 160;
    setOffset({ x: d.ox + (e.clientX - d.x) * k, y: d.oy + (e.clientY - d.y) * k });
  };

  return (
    <div className="picture-editor">
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => load(e.target.files?.[0])} />
      {img ? (
        <>
          <canvas
            ref={canvas}
            width={OUT}
            height={OUT}
            className="picture-crop"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={() => (drag.current = null)}
            aria-label="Drag to move the picture"
          />
          <label className="picture-zoom">
            <span>Zoom</span>
            <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          </label>
          <div className="hint">Drag the picture to place it in the circle.</div>
        </>
      ) : (
        <button type="button" className="btn" onClick={() => file.current?.click()}>
          <Camera size={15} /> Choose a picture
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
          Save picture
        </button>
      </div>
    </div>
  );
}

/** Settings → Profile → Profile picture. */
export function ProfilePicture({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = me.permissions.includes('profile.picture') || me.permissions.includes('users.pictures');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['me'] });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="label">Profile picture</label>
      <div className="profile-picture">
        <UserAvatar src={me.avatar} name={me.name || me.email} size={72} />
        <div className="stack" style={{ gap: 8 }}>
          {allowed ? (
            <>
              <div className="row-buttons">
                <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
                  <Camera size={15} /> {me.hasPicture ? 'Change' : 'Upload'}
                </button>
                {me.hasPicture && (
                  <button className="btn" disabled={busy} onClick={() => void run(() => api.deletePicture())}>
                    <Trash2 size={15} /> Remove
                  </button>
                )}
              </div>
              <label className="check">
                <input type="checkbox" checked={me.gravatar} disabled={busy} onChange={(e) => void run(() => api.setGravatar(e.target.checked))} />
                Use my Gravatar when there's no picture
              </label>
            </>
          ) : (
            <div className="hint">Your role doesn't allow changing your picture. An administrator can change it for you.</div>
          )}
        </div>
      </div>
      {editing && <PictureEditor busy={busy} onCancel={() => setEditing(false)} onSave={(d) => void run(() => api.setPicture(d))} />}
      {error && <div className="error-text">{error}</div>}
      <div className="hint">
        Gravatar pictures are fetched by your DreyMail server for {me.email.includes('@') ? me.email : 'your first mailbox address'}, so Gravatar never sees your
        browser.
      </div>
    </div>
  );
}
