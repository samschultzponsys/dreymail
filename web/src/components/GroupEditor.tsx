// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// A mailbox group: its name, color and icon, whether its mailboxes notify about new mail, whether
// they take the group's color and icon, and which mailboxes are in it.

import { useState } from 'react';
import type { AccountView, MailboxGroupInput, MailboxGroupView } from '../../../shared/types';
import { api } from '../api';
import { ACCOUNT_COLORS } from '../util';
import { MailboxIcon, MailboxIconPicker } from './MailboxIcon';

export function GroupEditor({ group, accounts, onDone, onCancel }: { group: MailboxGroupView | null; accounts: AccountView[]; onDone: (groups: MailboxGroupView[]) => void; onCancel: () => void }) {
  const [v, setV] = useState<MailboxGroupInput>(
    group ? { name: group.name, color: group.color, icon: group.icon, notify: group.notify, follow: group.follow, accountIds: group.accountIds } : { name: '', color: ACCOUNT_COLORS[2]!, icon: '', notify: true, follow: true, accountIds: [] },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setV((cur) => ({ ...cur, accountIds: cur.accountIds.includes(id) ? cur.accountIds.filter((x) => x !== id) : [...cur.accountIds, id] }));

  const run = async (fn: () => Promise<MailboxGroupView[]>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="dialog-body">
        <div className="grid2">
          <div>
            <label className="label" htmlFor="group-name">
              Group name
            </label>
            <input id="group-name" className="input" value={v.name} placeholder="Work" maxLength={60} autoFocus onChange={(e) => setV({ ...v, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Color</label>
            <div className="swatches">
              {ACCOUNT_COLORS.map((c) => (
                <button key={c} type="button" className={`swatch ${v.color.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setV({ ...v, color: c })} title={c} aria-label={`Color ${c}`} />
              ))}
              <label className={`swatch custom ${ACCOUNT_COLORS.includes(v.color.toLowerCase()) ? '' : 'on'}`} title="Pick any color" style={ACCOUNT_COLORS.includes(v.color.toLowerCase()) ? undefined : { boxShadow: `inset 0 0 0 5px ${v.color}` }}>
                <input type="color" value={v.color} onChange={(e) => setV({ ...v, color: e.target.value })} aria-label="Pick any color" />
              </label>
            </div>
          </div>
        </div>
        <MailboxIconPicker value={v.icon} color={v.color} onChange={(icon) => setV((cur) => ({ ...cur, icon: icon === 'image' ? '' : icon }))} />
        <div>
          <label className="label">Mailboxes in this group</label>
          {accounts.length === 0 && <div className="muted">No mailboxes yet.</div>}
          <div className="check-list">
            {accounts.map((a) => {
              const elsewhere = a.groupId && a.groupId !== group?.id;
              return (
                <label key={a.id} className="check">
                  <input type="checkbox" checked={v.accountIds.includes(a.id)} onChange={() => toggle(a.id)} />
                  <MailboxIcon icon={a.icon} image={a.iconImage} color={a.color} size={14} />
                  {a.name} <span className="muted">· {a.email}</span>
                  {elsewhere && !v.accountIds.includes(a.id) && <span className="muted">(in another group)</span>}
                </label>
              );
            })}
          </div>
          <div className="hint">A mailbox is in one group at a time; ticking it here moves it from its other group.</div>
        </div>
        <label className="check">
          <input type="checkbox" checked={v.follow} onChange={(e) => setV({ ...v, follow: e.target.checked })} />
          Mailboxes use the group&apos;s color and icon
          <span className="muted">(applied when you save; you can still change one mailbox afterwards)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={v.notify} onChange={(e) => setV({ ...v, notify: e.target.checked })} />
          Notify me about new mail in these mailboxes
        </label>
        {error && <div className="error-text">{error}</div>}
      </div>
      <div className="dialog-foot">
        {group && (
          <button className="btn danger-text" disabled={busy} onClick={() => window.confirm(`Delete the group “${group.name}”? Its mailboxes stay, ungrouped.`) && void run(() => api.deleteGroup(group.id))}>
            Delete group
          </button>
        )}
        <span className="grow" />
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !v.name.trim()} onClick={() => void run(() => api.saveGroup({ ...v, name: v.name.trim() }, group?.id))}>
          Save
        </button>
      </div>
    </>
  );
}
