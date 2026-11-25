// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-25: also decodes whole messages being opened (DreyMail 14.1).

// A worker thread for the search index (DreyMail 12.10): reads a message (MIME, HTML) and returns
// its words, so this CPU-heavy part runs beside the server, not in its way.

import { parentPort } from 'node:worker_threads';
import { convert } from 'html-to-text';
import { parseRaw } from '../mail/parse.js';
import { MAX_BODY_TERMS, termsOf } from './searchTerms.js';

/** The words of a message's text, its HTML and its attachments' names; null when it can't be read. */
export async function messageTerms(raw: Buffer): Promise<string[] | null> {
  try {
    const e = await parseRaw(raw);
    const text = e.text || (e.html ? convert(e.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { ignoreHref: true } }] }) : '');
    return [...termsOf([text, ...e.attachments.map((a) => a.filename ?? '')].join(' '), MAX_BODY_TERMS)];
  } catch {
    return null;
  }
}

parentPort?.on('message', (m: { id: number; raw: Uint8Array; kind?: 'terms' | 'parse' }) => {
  if (m.kind === 'parse') {
    // A message being opened (DreyMail 14.1): decoded here, its attachments handed over without copying.
    void parseRaw(Buffer.from(m.raw)).then(
      (email) => {
        const moved = email.attachments.map((a) => a.content).filter((c): c is ArrayBuffer => c instanceof ArrayBuffer);
        parentPort!.postMessage({ id: m.id, email }, moved);
      },
      (err: Error) => parentPort!.postMessage({ id: m.id, error: err.message || 'Unreadable message' }),
    );
    return;
  }
  void messageTerms(Buffer.from(m.raw)).then((terms) => parentPort!.postMessage({ id: m.id, terms }));
});
