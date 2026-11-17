// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { StorageDatabaseUsage, StorageReport, StorageUserUsage } from '../../../shared/types';
import { api } from '../api';
import { formatSize } from '../util';
import { UserAvatar } from './UserPicture';

const DATABASE_PARTS: [keyof StorageDatabaseUsage, string][] = [
  ['settings', 'Mailboxes and settings'],
  ['pictures', 'Pictures'],
  ['calendar', 'Calendar'],
  ['scheduled', 'Scheduled mail'],
  ['ai', 'AI assistant'],
];

const sum = (n: number[]) => n.reduce((s, x) => s + x, 0);
const databaseBytes = (u: StorageUserUsage) => sum(Object.values(u.database));
const summaryBytes = (u: StorageUserUsage) => sum(u.mailboxes.map((m) => m.messageBytes));
const contentBytes = (u: StorageUserUsage) => sum(u.mailboxes.map((m) => m.bodyBytes));
const count = (n: number) => n.toLocaleString();

const REFILL = 'Their mail stays on the mail servers; the copy fills again in the background the next time they use DreyMail.';

/** Settings → Storage (administration): how much space each user takes up, and clearing their mail cache. */
export function StorageAdmin() {
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ['admin', 'storage'], queryFn: api.adminStorage });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = async (u: StorageUserUsage, mailbox?: StorageUserUsage['mailboxes'][number]) => {
    const what = mailbox ? `the cached mail of ${mailbox.name ?? 'this removed mailbox'}` : `all cached mail of ${u.name}`;
    if (!window.confirm(`Clear ${what}? ${REFILL}`)) return;
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData<StorageReport>(['admin', 'storage'], await api.adminClearCache(u.id, mailbox?.accountId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!report.data) return <div className="hint">{report.error ? (report.error as Error).message : 'Loading…'}</div>;
  const { users, files, cacheEnabled } = report.data;
  const largest = Math.max(1, ...users.map((u) => u.total));

  return (
    <div className="stack">
      <div className="hint">
        Space each user takes up on this server: their copy of mail in the mail cache (message lists, and the content of messages kept
        for opening at once) and their own data (mailboxes, settings, pictures, calendar, scheduled mail). Mail itself stays on the mail
        servers. Sizes are of the stored data; the files on disk are somewhat larger. Space freed by clearing a cache is reused, but the
        cache.db file doesn't shrink.
      </div>
      <div className="storage-files">
        {files.map((f) => (
          <div key={f.name} className="storage-file">
            <span className="muted">{f.name}</span>
            <strong>{formatSize(f.bytes)}</strong>
          </div>
        ))}
        <button className="icon-btn" title="Update" disabled={report.isFetching} onClick={() => void report.refetch()}>
          <RefreshCw size={16} className={report.isFetching ? 'spin' : undefined} />
        </button>
      </div>
      {!cacheEnabled && <div className="hint">The mail cache is switched off (DREYMAIL_CACHE=false), so only users' own data takes up space.</div>}
      {error && <div className="error-text">{error}</div>}
      <div className="storage-legend muted">
        <span>
          <i className="storage-swatch lists" /> Message lists
        </span>
        <span>
          <i className="storage-swatch content" /> Message content
        </span>
        <span>
          <i className="storage-swatch data" /> Own data
        </span>
      </div>
      <ul className="user-list storage-list">
        {users.map((u) => {
          const expanded = open === u.id;
          const parts = [
            ['lists', summaryBytes(u)],
            ['content', contentBytes(u)],
            ['data', databaseBytes(u)],
          ] as const;
          const messages = sum(u.mailboxes.map((m) => m.messages));
          return (
            <li key={u.id} className="storage-user">
              <button className="storage-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : u.id)}>
                {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <UserAvatar src={u.avatar} name={u.name} size={30} />
                <div className="user-main">
                  <div className="user-name">
                    {u.name}
                    <span className="storage-total">{formatSize(u.total)}</span>
                  </div>
                  <div className="storage-bar" style={{ width: `${Math.max(2, (u.total / largest) * 100)}%` }} aria-hidden>
                    {parts.map(([k, v]) => (v > 0 ? <span key={k} className={`storage-seg ${k}`} style={{ flexGrow: v }} /> : null))}
                  </div>
                  <div className="muted user-meta">
                    {u.mailboxes.length} {u.mailboxes.length === 1 ? 'mailbox' : 'mailboxes'} cached · {count(messages)} messages
                  </div>
                </div>
              </button>
              {expanded && (
                <div className="storage-detail">
                  <div className="storage-scroll">
                    <table className="storage-table">
                      <thead>
                        <tr>
                          <th>Mail cache</th>
                          <th className="storage-narrow-hide">Folders</th>
                          <th>Messages</th>
                          <th>Lists</th>
                          <th>Content</th>
                          <th aria-label="Clear" />
                        </tr>
                      </thead>
                      <tbody>
                        {u.mailboxes.length === 0 && (
                          <tr>
                            <td colSpan={6} className="muted">
                              Nothing cached
                            </td>
                          </tr>
                        )}
                        {u.mailboxes.map((m) => (
                          <tr key={m.accountId}>
                            <td>
                              {m.name ?? <span className="muted">Removed mailbox</span>}
                              {m.email && <div className="muted user-meta">{m.email}</div>}
                            </td>
                            <td className="storage-narrow-hide">{count(m.folders)}</td>
                            <td>{count(m.messages)}</td>
                            <td>{formatSize(m.messageBytes)}</td>
                            <td title={`${count(m.bodies)} messages kept`}>{formatSize(m.bodyBytes)}</td>
                            <td>
                              <button className="icon-btn danger-text" title="Clear this mailbox's cache" disabled={busy} onClick={() => void clear(u, m)}>
                                <Trash2 size={15} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {u.mailboxes.length > 0 && (
                      <button className="btn storage-clear" disabled={busy} onClick={() => void clear(u)}>
                        <Trash2 size={15} /> Clear {u.name}'s mail cache
                      </button>
                    )}
                  </div>
                  <table className="storage-table">
                    <thead>
                      <tr>
                        <th>Own data</th>
                        <th>Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {DATABASE_PARTS.map(([k, label]) => (
                        <tr key={k}>
                          <td>{label}</td>
                          <td>{formatSize(u.database[k])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
