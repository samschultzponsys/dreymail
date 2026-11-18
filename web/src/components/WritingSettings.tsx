// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchJson } from '../api';
import { resolveAddressLine, setAddressLine, type AddressLine, type AddressLineLevel } from '../../../shared/addressLines';
import type { AccountView, Preferences, SuggestScope } from '../../../shared/types';
import { api } from '../api';

const SCOPES: [SuggestScope, string, string][] = [
  ['all', 'All mailboxes', 'People from every mailbox'],
  ['mailbox', 'The mailbox you write from', 'Only people that mailbox has written to or heard from'],
  ['group', 'The group of the mailbox you write from', 'People from the mailboxes in its group (or just it, outside a group)'],
  ['chosen', 'Chosen mailboxes', 'People from the mailboxes ticked below, whichever you write from'],
];

const LINES: [AddressLine, string][] = [
  ['cc', 'Cc'],
  ['bcc', 'Bcc'],
];

/** Settings → General: where address suggestions come from, and when the Cc and Bcc lines show. */
export function WritingSettings({ prefs, save, accounts }: { prefs: Preferences; save: (p: Preferences) => void; accounts: AccountView[] }) {
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups, staleTime: 60_000 });
  const scope = prefs.suggestScope ?? 'all';
  const chosen = prefs.suggestAccounts ?? [];
  const lines = prefs.addressLines;

  /** One group's or mailbox's own choice for a line: follow the level above, show, or hide. */
  const override = (level: AddressLineLevel, target: { id: string; groupId?: string | null }, line: AddressLine, above: boolean) => {
    const own = level === 'mailbox' ? lines?.accounts[target.id]?.[line] : lines?.groups[target.id]?.[line];
    const value = own === undefined ? 'default' : own ? 'show' : 'hide';
    // A group's setting is stored under its id; setAddressLine finds it through a mailbox-like target.
    const asAccount = level === 'group' ? { id: '', groupId: target.id } : target;
    return (
      <select
        key={`${level}:${target.id}:${line}`}
        className="input compact"
        aria-label={line === 'cc' ? 'Cc' : 'Bcc'}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          save({ ...prefs, addressLines: setAddressLine(lines, asAccount, level, line, v === 'default' ? undefined : v === 'show') });
        }}
      >
        <option value="default">As above ({above ? 'shown' : 'hidden'})</option>
        <option value="show">Always shown</option>
        <option value="hide">When needed</option>
      </select>
    );
  };

  return (
    <>
      <div>
        <label className="label">Suggest addresses from</label>
        <div className="check-list">
          {SCOPES.map(([key, label, hint]) => (
            <label key={key} className="check">
              <input type="radio" name="suggest-scope" checked={scope === key} onChange={() => save({ ...prefs, suggestScope: key })} />
              {label} <span className="muted">{hint}</span>
            </label>
          ))}
        </div>
        {scope === 'chosen' && (
          <div className="check-list indent">
            {accounts.map((a) => (
              <label key={a.id} className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(a.id)}
                  onChange={(e) => save({ ...prefs, suggestAccounts: e.target.checked ? [...chosen, a.id] : chosen.filter((id) => id !== a.id) })}
                />
                {a.name} <span className="muted">{a.email}</span>
              </label>
            ))}
          </div>
        )}
        <div className="hint">
          While you type an address, DreyMail suggests people you have written to and people who wrote to you (not newsletters or no-reply senders),
          those you write to most first.
        </div>
        <CompanyDirectory prefs={prefs} save={save} accounts={accounts} />
      </div>
      <SmimeSettings accounts={accounts} />

      <div>
        <label className="label">Cc and Bcc lines</label>
        <div className="check-list">
          {LINES.map(([line, name]) => (
            <label key={line} className="check">
              <input
                type="checkbox"
                checked={resolveAddressLine(lines, undefined, line).show}
                onChange={(e) => save({ ...prefs, addressLines: setAddressLine(lines, undefined, 'all', line, e.target.checked) })}
              />
              Always show {name} <span className="muted">(all mailboxes)</span>
            </label>
          ))}
        </div>
        {(groups.data?.length || accounts.length > 1) && (
          <table className="line-table">
            <thead>
              <tr>
                <th />
                <th>Cc</th>
                <th>Bcc</th>
              </tr>
            </thead>
            <tbody>
              {(groups.data ?? []).map((g) => (
                <tr key={`g:${g.id}`}>
                  <td>
                    {g.name} <span className="muted">group</span>
                  </td>
                  {LINES.map(([line]) => (
                    <td key={line}>
                      {override('group', { id: g.id }, line, resolveAddressLine(lines, undefined, line).show)}
                    </td>
                  ))}
                </tr>
              ))}
              {accounts.map((a) => (
                <tr key={`a:${a.id}`}>
                  <td>{a.name}</td>
                  {LINES.map(([line]) => (
                    <td key={line}>
                      {override('mailbox', a, line, resolveAddressLine(setAddressLine(lines, a, 'mailbox', line, undefined), a, line).show)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="hint">
          A mailbox's own choice wins over its group's, and a group's over the one for all mailboxes. The pin at the end of the Cc and Bcc lines while writing
          changes whichever setting applies to the mailbox you write from. A hidden line is a click away (Cc or Bcc on the To line).
        </div>
      </div>
    </>
  );
}

/**
 * The company directory in suggestions (DreyMail 10.3): Microsoft 365 and Google Workspace
 * mailboxes can add their organization's people, once the user allows it per mailbox.
 */
function CompanyDirectory({ prefs, save, accounts }: { prefs: Preferences; save: (p: Preferences) => void; accounts: AccountView[] }) {
  const q = useQuery({ queryKey: ['directory'], queryFn: () => fetchJson<{ accountId: string; kind: 'microsoft' | 'google'; allowed: boolean }[]>('GET', '/api/directory'), staleTime: 60_000 });
  if (!q.data?.length) return null;
  const allow = (a: AccountView, kind: 'microsoft' | 'google') =>
    void fetchJson<{ url: string }>('POST', `/api/oauth/${kind}/start`, { color: a.color, allow: [kind === 'microsoft' ? 'people' : 'directory'] }).then(
      ({ url }) => (window.location.href = url),
      (e: Error) => window.alert(e.message),
    );
  return (
    <div style={{ marginTop: 10 }}>
      <label className="check">
        <input type="checkbox" checked={prefs.suggestDirectory !== false} onChange={(e) => save({ ...prefs, suggestDirectory: e.target.checked })} /> Also suggest people from the company
        directory
      </label>
      <div className="check-list">
        {q.data.map((d) => {
          const a = accounts.find((x) => x.id === d.accountId);
          if (!a) return null;
          return (
            <div key={d.accountId} className="cal-when-row">
              <span className="grow">
                {a.name} <span className="muted">({d.kind === 'microsoft' ? 'Microsoft 365' : 'Google Workspace'})</span>
              </span>
              {d.allowed ? (
                <span className="muted">Allowed</span>
              ) : (
                <button className="btn" onClick={() => allow(a, d.kind)}>
                  Allow
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="hint">
        Allow signs in to the mailbox again, asking {q.data.some((d) => d.kind === 'microsoft') ? 'Microsoft for "People.Read"' : ''}
        {q.data.some((d) => d.kind === 'microsoft') && q.data.some((d) => d.kind === 'google') ? ' and ' : ''}
        {q.data.some((d) => d.kind === 'google') ? 'Google for the directory (an administrator turns on the People API in Google Cloud Console)' : ''}. Searching is done by
        the server, only after two letters.
      </div>
    </div>
  );
}

/** Settings → General: S/MIME certificates per mailbox (DreyMail 10.6). */
function SmimeSettings({ accounts }: { accounts: AccountView[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['smime'], queryFn: () => fetchJson<{ accountId: string; email: string; subject: string; notAfter: string }[]>('GET', '/api/smime') });
  const [error, setError] = useState<string | null>(null);
  const importFor = (a: AccountView) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.p12,.pfx,application/x-pkcs12';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const password = window.prompt(`Password of ${file.name}:`) ?? '';
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      try {
        await fetchJson('PUT', `/api/smime/${encodeURIComponent(a.id)}`, { file: btoa(bin), password });
        setError(null);
        void qc.invalidateQueries({ queryKey: ['smime'] });
      } catch (e) {
        setError((e as Error).message);
      }
    };
    input.click();
  };
  const remove = (a: AccountView) => {
    if (!window.confirm(`Remove the certificate of ${a.name}? Encrypted mail to it can't be read in DreyMail without it.`)) return;
    void fetchJson('DELETE', `/api/smime/${encodeURIComponent(a.id)}`).then(() => qc.invalidateQueries({ queryKey: ['smime'] }), (e: Error) => setError(e.message));
  };
  return (
    <div>
      <label className="label">Signed and encrypted mail (S/MIME)</label>
      <div className="check-list">
        {accounts.map((a) => {
          const c = q.data?.find((x) => x.accountId === a.id);
          return (
            <div key={a.id} className="cal-when-row">
              <span className="grow">
                {a.name}{' '}
                {c ? (
                  <span className="muted">
                    · {c.email || c.subject} · until {new Date(c.notAfter).toLocaleDateString()}
                  </span>
                ) : (
                  <span className="muted">· no certificate</span>
                )}
              </span>
              <button className="btn" onClick={() => importFor(a)}>
                {c ? 'Replace…' : 'Import…'}
              </button>
              {c && (
                <button className="btn" onClick={() => remove(a)}>
                  Remove
                </button>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="hint">
        Import your certificate as a .p12 or .pfx file (with its private key) to read mail encrypted to you and to sign or encrypt what you send (the lock
        and signature buttons in the composer). Signed mail you get is checked by itself, and the sender&apos;s certificate is kept so you can encrypt to them.
        The key is stored encrypted on the server.
      </div>
    </div>
  );
}
