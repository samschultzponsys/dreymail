// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Settings → Search and storage (DreyMail 12.3): your space for cached mail and its search index,
// split across your mailboxes evenly or by the shares you choose, and how far each is indexed.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { CacheSplit, Preferences } from '../../../shared/types';
import { fetchJson } from '../api';
import { useAccounts } from '../hooks';
import { MailboxIcon } from './MailboxIcon';

type Used = { messages: number; bodies: number; index: number; total: number; count: number; indexed: number };
type Usage = { enabled: boolean; userMb: number; split: CacheSplit; accounts: { accountId: string; share: number; budget: number; used: Used; indexing: boolean; coverage?: { folders: number; instant: number } }[] };

const mb = (b: number) => (b >= 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(2)} GB` : `${Math.round(b / 1024 / 1024)} MB`);

/** Shares that add up to 100 (whole percents), keeping the proportions. */
export function normalizeShares(ids: string[], shares: Record<string, number>): Record<string, number> {
  const raw = ids.map((id) => Math.max(0, shares[id] ?? 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) return Object.fromEntries(ids.map((id, i) => [id, Math.floor(100 / ids.length) + (i < 100 % ids.length ? 1 : 0)]));
  const exact = raw.map((v) => (v / sum) * 100);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  for (const i of exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return Object.fromEntries(ids.map((id, i) => [id, out[i]!]));
}

export function CacheSettings({ prefs, save }: { prefs: Preferences; save: (p: Preferences) => Promise<void> | void }) {
  const qc = useQueryClient();
  const accounts = useAccounts().data ?? [];
  const usage = useQuery({ queryKey: ['cache-usage'], queryFn: () => fetchJson<Usage>('GET', '/api/cache/usage'), refetchInterval: 10_000 });
  const ids = accounts.map((a) => a.id);
  const split = prefs.cacheSplit ?? { mode: 'even', shares: {} };
  const [draft, setDraft] = useState<Record<string, number>>(() => normalizeShares(ids, split.shares));
  useEffect(() => setDraft(normalizeShares(ids, (prefs.cacheSplit ?? { shares: {} }).shares)), [ids.join(','), prefs.cacheSplit]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (next: CacheSplit) => {
    await save({ ...prefs, cacheSplit: next });
    await fetchJson('POST', '/api/cache/rebalance').catch(() => {});
    void qc.invalidateQueries({ queryKey: ['cache-usage'] });
  };
  const total = Object.values(draft).reduce((a, b) => a + b, 0);
  const u = usage.data;
  if (u && !u.enabled) return <div className="hint">This server doesn&apos;t keep a copy of mail, so searches always go to the mail servers.</div>;
  const used = (u?.accounts ?? []).reduce((a, x) => a + x.used.total, 0);

  return (
    <div className="stack">
      <div className="hint">
        DreyMail keeps an encrypted copy of your mail on its server, with a search index, so lists open at once and searches are answered without asking the
        mail servers. A folder is searched instantly once it is all copied and indexed; until then (or for a folder bigger than the copy holds) the mail
        server searches it. Searches match whole words (&quot;printer&quot; also finds &quot;printers&quot;).
      </div>
      {u && (
        <div className="cache-total">
          <div className="cache-bar">
            <span style={{ width: `${Math.min(100, (used / Math.max(1, u.userMb * 1024 * 1024)) * 100)}%` }} />
          </div>
          <div className="muted">
            {mb(used)} of {u.userMb >= 1024 ? `${(u.userMb / 1024).toFixed(u.userMb % 1024 ? 1 : 0)} GB` : `${u.userMb} MB`} used (your space, set by the administrator)
          </div>
        </div>
      )}

      <div>
        <label className="label">Split across your mailboxes</label>
        <div className="cal-when-row">
          <label className="check">
            <input type="radio" checked={split.mode === 'even'} onChange={() => void apply({ mode: 'even', shares: split.shares })} />
            Evenly
          </label>
          <label className="check">
            <input type="radio" checked={split.mode === 'custom'} onChange={() => void apply({ mode: 'custom', shares: normalizeShares(ids, split.shares) })} />
            By my choice
          </label>
        </div>
      </div>

      <ul className="user-list cache-list">
        {accounts.map((a) => {
          const row = u?.accounts.find((x) => x.accountId === a.id);
          const pct = row && row.used.count > 0 ? Math.round((row.used.indexed / row.used.count) * 100) : 0;
          return (
            <li key={a.id}>
              <MailboxIcon icon={a.icon} image={a.iconImage} color={a.color} size={16} />
              <div className="user-main">
                <div className="user-name">{a.name}</div>
                <div className="muted user-meta">
                  {row ? (
                    <>
                      {mb(row.used.total)} of {mb(row.budget)} · {row.used.count.toLocaleString()} messages · {pct}% indexed
                      {row.indexing ? ' (indexing…)' : ''}
                      {row.coverage && row.coverage.folders > 0 ? ` · ${row.coverage.instant} of ${row.coverage.folders} folders searched instantly` : ''}
                      {row.used.total >= row.budget * 0.97 ? ' · full: give it a bigger share for more' : ''}
                    </>
                  ) : (
                    '…'
                  )}
                </div>
                {row && (
                  <div className="cache-bar small">
                    <span style={{ width: `${Math.min(100, (row.used.total / Math.max(1, row.budget)) * 100)}%`, background: a.color }} />
                  </div>
                )}
              </div>
              {split.mode === 'custom' ? (
                <span className="cache-share">
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={100}
                    inputMode="numeric"
                    aria-label={`${a.name}'s share (percent)`}
                    value={draft[a.id] ?? 0}
                    onChange={(e) => setDraft((d) => ({ ...d, [a.id]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))}
                  />
                  %
                </span>
              ) : (
                <span className="muted">{row ? `${Math.round(row.share * 100)}%` : ''}</span>
              )}
            </li>
          );
        })}
      </ul>
      {split.mode === 'custom' && (
        <div className="cal-when-row">
          <span className={total === 100 ? 'muted' : 'warning-text'}>Total {total}%{total !== 100 ? ' (saved as proportions)' : ''}</span>
          <button className="btn primary" onClick={() => void apply({ mode: 'custom', shares: normalizeShares(ids, draft) })}>
            Save shares
          </button>
          <button className="btn" onClick={() => setDraft(normalizeShares(ids, {}))}>
            Even them out
          </button>
        </div>
      )}
    </div>
  );
}
