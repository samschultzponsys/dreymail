// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-25: the pictures beside the one shown are fetched ahead.

import { ChevronLeft, ChevronRight, CircleAlert, Download, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AttachmentView } from '../../../shared/types';
import { downloadLabel, fetchAttachmentBlob, saveWithLink, type DownloadState } from '../download';
import { formatSize } from '../util';

export interface ViewerImage {
  url: string;
  attachment: AttachmentView;
}

/**
 * Attached pictures, full size over the app: arrows (or ← →) between them, Download, Esc or a
 * click beside the picture to close. Each picture is fetched once and shown from memory (a blob:
 * URL of its own type), never from the server's download address. The pictures before and after
 * the one shown are fetched ahead (DreyMail 14.1), so the arrows show them at once.
 */
export function ImageViewer({ images, start, onClose }: { images: ViewerImage[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const [blobs, setBlobs] = useState<Record<number, { url: string; blob: Blob }>>({});
  const [state, setState] = useState<DownloadState>({ status: 'idle' });
  const urls = useRef<string[]>([]);
  const current = images[index]!;
  const loaded = blobs[index];

  /** Downloads under way (or done), per picture; all stop when the viewer closes. */
  const loading = useRef(new Map<number, Promise<Blob | null>>());
  const closing = useRef(new AbortController());
  /** The picture being shown follows its download's progress; ones fetched ahead don't. */
  const shown = useRef(index);
  shown.current = index;

  useEffect(
    () => () => {
      closing.current.abort();
      urls.current.forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );

  const load = (i: number): Promise<Blob | null> => {
    let job = loading.current.get(i);
    if (!job) {
      const img = images[i]!;
      job = fetchAttachmentBlob(img.url, img.attachment.mimeType, (s) => shown.current === i && setState(s), { signal: closing.current.signal }).then((blob) => {
        if (!blob || closing.current.signal.aborted) {
          loading.current.delete(i);
          return null;
        }
        const url = URL.createObjectURL(blob);
        urls.current.push(url);
        setBlobs((b) => ({ ...b, [i]: { url, blob } }));
        return blob;
      });
      loading.current.set(i, job);
    }
    return job;
  };

  useEffect(() => {
    if (!blobs[index]) setState({ status: 'preparing' });
    let gone = false;
    void load(index).then((blob) => {
      if (gone || !blob || images.length < 2) return;
      // Then the next one and the one before, one at a time.
      void load((index + 1) % images.length).then(() => {
        if (!gone) void load((index - 1 + images.length) % images.length);
      });
    });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const go = (d: number) => setIndex((i) => (i + d + images.length) % images.length);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight' && images.length > 1) go(1);
      else if (e.key === 'ArrowLeft' && images.length > 1) go(-1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images.length, onClose]);

  const save = () => {
    if (loaded) saveWithLink(loaded.blob, current.attachment.filename);
  };

  // On <body>: the reader pane is a CSS container, which would trap a fixed overlay inside it.
  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={current.attachment.filename} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="iv-bar">
        <span className="iv-name" title={current.attachment.filename}>
          {current.attachment.filename}
          <span className="iv-meta">
            {formatSize(current.attachment.size)}
            {images.length > 1 && ` · ${index + 1} of ${images.length}`}
          </span>
        </span>
        <button className="iv-btn" title="Download" disabled={!loaded} onClick={save}>
          <Download size={18} />
        </button>
        <button className="iv-btn" title="Close (Esc)" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="iv-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {loaded ? (
          <img src={loaded.url} alt={current.attachment.filename} draggable={false} />
        ) : state.status === 'error' ? (
          <div className="iv-status">
            <CircleAlert size={22} /> Couldn&apos;t open {current.attachment.filename}: {state.message}
          </div>
        ) : (
          <div className="iv-status">
            <LoaderCircle size={22} className="spin" /> {downloadLabel(state) ?? 'Loading…'}
          </div>
        )}
      </div>
      {images.length > 1 && (
        <>
          <button className="iv-nav prev" title="Previous (←)" onClick={() => go(-1)}>
            <ChevronLeft size={26} />
          </button>
          <button className="iv-nav next" title="Next (→)" onClick={() => go(1)}>
            <ChevronRight size={26} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
