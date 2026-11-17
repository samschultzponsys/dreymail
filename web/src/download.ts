// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-17: pictures fetched for the image viewer.

import { ApiError } from './api';

/** How far along an attachment download is: shown on its chip while it runs. */
export type DownloadState =
  | { status: 'idle' }
  /** Waiting for the server, which fetches the message from the mail server first. */
  | { status: 'preparing' }
  | { status: 'receiving'; received: number; total: number | null }
  | { status: 'done' }
  | { status: 'error'; message: string };

/** 0–100, or null while there is nothing to measure yet. */
export function downloadPercent(s: DownloadState): number | null {
  if (s.status !== 'receiving' || !s.total) return null;
  return Math.min(100, Math.round((s.received / s.total) * 100));
}

/** Short text for the chip, e.g. "Preparing…", "42%", "Saved". */
export function downloadLabel(s: DownloadState): string | null {
  switch (s.status) {
    case 'preparing':
      return 'Preparing…';
    case 'receiving': {
      const pct = downloadPercent(s);
      return pct === null ? 'Downloading…' : `${pct}%`;
    }
    case 'done':
      return 'Saved';
    case 'error':
      return 'Failed';
    default:
      return null;
  }
}

/** Hands the finished file to the browser's downloads (default: a click on a blob link). */
export type SaveFile = (blob: Blob, filename: string) => void;

export const saveWithLink: SaveFile = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

/**
 * Fetch an attachment and save it, reporting progress on the way, so a click gives immediate
 * feedback instead of the file silently appearing in the downloads folder much later.
 */
export async function downloadFile(
  url: string,
  filename: string,
  onState: (s: DownloadState) => void,
  opts: { fetch?: typeof fetch; save?: SaveFile; signal?: AbortSignal } = {},
): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  const save = opts.save ?? saveWithLink;
  onState({ status: 'preparing' });
  try {
    const res = await doFetch(url, { credentials: 'same-origin', signal: opts.signal });
    if (!res.ok) {
      let msg = res.statusText || `HTTP ${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* not JSON */
      }
      throw new ApiError(msg, res.status);
    }
    const header = Number(res.headers.get('content-length'));
    const total = Number.isFinite(header) && header > 0 ? header : null;
    let received = 0;
    onState({ status: 'receiving', received, total });
    const chunks: BlobPart[] = [];
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onState({ status: 'receiving', received, total });
      }
    } else {
      chunks.push(await res.arrayBuffer());
    }
    save(new Blob(chunks, { type: res.headers.get('content-type') ?? 'application/octet-stream' }), filename);
    onState({ status: 'done' });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      onState({ status: 'idle' });
      return;
    }
    onState({ status: 'error', message: (err as Error).message || 'Download failed' });
  }
}

/**
 * Picture types shown in DreyMail's image viewer (DreyMail). SVG is left out on purpose: it can
 * carry scripts, so it is only ever downloaded.
 */
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

export function isViewableImage(mimeType: string): boolean {
  return VIEWABLE.has(mimeType.toLowerCase().split(';')[0]!.trim());
}

/** Fetch an attachment as a Blob of its own type (the server always sends octet-stream), with progress. */
export function fetchAttachmentBlob(url: string, mimeType: string, onState: (s: DownloadState) => void, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<Blob | null> {
  return new Promise((resolve) => {
    let blob: Blob | null = null;
    void downloadFile(
      url,
      '',
      (s) => {
        onState(s);
        if (s.status === 'done') resolve(blob);
        if (s.status === 'error' || (s.status === 'idle' && opts.signal?.aborted)) resolve(null);
      },
      { ...opts, save: (b) => (blob = new Blob([b], { type: mimeType })) },
    );
  });
}
