// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import type { VersionInfo } from '../../../shared/types';
import { api } from '../api';

/** Inline markdown of CHANGES.md: `code`, **bold**, [links](https://…). Built as elements, never as HTML. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={m.index}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={m.index}>{m[2]}</strong>);
    else out.push(<a key={m.index} href={m[4]} target="_blank" rel="noreferrer noopener">{m[3]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The release entries of CHANGES.md (from the first "## " heading), as headings, bullets and paragraphs. */
export function renderChangelog(markdown: string): ReactNode[] {
  const start = markdown.search(/^## /m);
  const lines = (start >= 0 ? markdown.slice(start) : markdown).split('\n');
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`u${blocks.length}`}>{list.map((li, i) => <li key={i}>{inline(li)}</li>)}</ul>);
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(' '))}</p>);
    list = [];
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^## /.test(line)) {
      flush();
      blocks.push(<h3 key={`h${blocks.length}`}>{inline(line.slice(3))}</h3>);
    } else if (/^### /.test(line)) {
      flush();
      blocks.push(<h4 key={`h${blocks.length}`}>{inline(line.slice(4))}</h4>);
    } else if (/^- /.test(line)) {
      if (para.length) flush();
      list.push(line.slice(2));
    } else if (/^\s+\S/.test(line) && list.length) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else if (line.trim() === '' || line.trim() === '---') {
      flush();
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>);
}

/** "What's new": the changelog, and how to update when a newer image is out. */
export function ChangelogDialog({ version, onClose }: { version: VersionInfo; onClose: () => void }) {
  const log = useQuery({ queryKey: ['changelog'], queryFn: api.changelog, staleTime: Infinity });
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(680px, 100%)' }}>
        <div className="dialog-head">
          <h2>What's new · DreyMail {version.version}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body changelog">
          {version.update && (
            <div className="update-banner">
              <strong>DreyMail {version.update.version} is available.</strong> Pull the new image to update: in Arcane, redeploy the DreyMail stack
              (it uses <code>:latest</code>). Your data stays.{' '}
              <a href={version.update.url} target="_blank" rel="noreferrer noopener">
                Release notes
              </a>
            </div>
          )}
          {log.data ? renderChangelog(log.data.markdown) : <div className="hint">{log.error ? (log.error as Error).message : 'Loading…'}</div>}
        </div>
      </div>
    </div>
  );
}
