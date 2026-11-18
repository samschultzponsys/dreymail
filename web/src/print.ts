// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Printing a message: its header and body in a hidden frame, printed with the system's dialog.
// The body is the server's sanitized HTML (no scripts); the frame allows no scripts either.

import type { Address, MessageDetail } from '../../shared/types';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const who = (list: Address[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

/** The document printed for a message. */
export function printDocument(d: MessageDetail): string {
  const rows = [
    ['From', who(d.from)],
    ['To', who(d.to)],
    ...(d.cc.length ? [['Cc', who(d.cc)]] : []),
    ['Date', new Date(d.date).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })],
    ...(d.attachments.filter((a) => !a.inline).length ? [['Attachments', d.attachments.filter((a) => !a.inline).map((a) => a.filename).join(', ')]] : []),
  ];
  const body = d.html ?? `<pre style="white-space:pre-wrap;font:inherit">${esc(d.text ?? '')}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.subject || '(no subject)')}</title>
<style>body{font:14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111;margin:24px}h1{font-size:20px;margin:0 0 10px}
table.dm-head{border-collapse:collapse;margin-bottom:14px;font-size:13px}table.dm-head th{text-align:left;color:#555;font-weight:600;padding:1px 12px 1px 0;vertical-align:top}
hr.dm{border:0;border-top:1px solid #ccc;margin:0 0 16px}img{max-width:100%}${d.css}</style></head><body>
<h1>${esc(d.subject || '(no subject)')}</h1><table class="dm-head">${rows.map(([k, v]) => `<tr><th>${esc(k!)}</th><td>${esc(v!)}</td></tr>`).join('')}</table><hr class="dm">${body}</body></html>`;
}

export function printMessage(d: MessageDetail) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-modals allow-same-origin');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  frame.srcdoc = printDocument(d);
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      setTimeout(() => frame.remove(), 60_000);
    }
  };
  document.body.appendChild(frame);
}
