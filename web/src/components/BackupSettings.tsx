// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Settings → Backup (DreyMail 11.9): download your data as a password-protected file, restore it
// (here or on another DreyMail server), or restore from the server's automatic daily backups.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { fetchJson } from '../api';

type Snapshot = { name: string; createdAt: string; bytes: number };

const WHAT =
  'Your mailboxes (with their passwords and sign-ins), groups, signatures, settings, rules, auto-replies, blocked senders, saved searches, follow-ups, contacts, tasks, calendars, S/MIME certificates and AI connections. Not included: passkeys and this device’s notifications (set them up again), mail itself (it stays on your mail servers).';

/** Reads a file as base64 (without the data: prefix). */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

export function BackupSettings() {
  const qc = useQueryClient();
  const auto = useQuery({ queryKey: ['backup', 'automatic'], queryFn: () => fetchJson<{ keepDays: number; backups: Snapshot[] }>('GET', '/api/backup/automatic') });
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [filePassword, setFilePassword] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const done = (text: string) => {
    setMessage({ text });
    // Everything may have changed: load it all again.
    void qc.invalidateQueries();
  };
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    setMessage(null);
    try {
      await f();
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };

  const download = () =>
    run('download', async () => {
      if (password.length < 8) throw new Error('Use a backup password of at least 8 characters');
      if (password !== password2) throw new Error('The two passwords are not the same');
      const r = await fetchJson<{ url: string; name: string }>('POST', '/api/backup/prepare', { password });
      const a = document.createElement('a');
      a.href = r.url;
      a.download = r.name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setPassword('');
      setPassword2('');
      setMessage({ text: `Saved as ${r.name}. Keep the password: without it the file can't be opened.` });
    });

  const restoreFile = () =>
    run('file', async () => {
      if (!file) throw new Error('Choose a backup file');
      if (!confirm('Restore this backup? Your mailboxes, settings and the rest are replaced by the backup’s.')) return;
      const r = await fetchJson<{ from: string }>('POST', '/api/backup/restore', { file: await base64Of(file), password: filePassword });
      setFile(null);
      setFilePassword('');
      if (fileInput.current) fileInput.current.value = '';
      done(`Restored the backup from ${new Date(r.from).toLocaleString()}.`);
    });

  const restoreAuto = (s: Snapshot) =>
    run(s.name, async () => {
      if (!confirm(`Restore your data from the automatic backup of ${new Date(s.createdAt).toLocaleString()}? Your mailboxes, settings and the rest are replaced by the backup’s.`)) return;
      await fetchJson('POST', `/api/backup/automatic/${encodeURIComponent(s.name)}/restore`);
      done(`Restored from the backup of ${new Date(s.createdAt).toLocaleString()}.`);
    });

  return (
    <div className="stack">
      <div className="hint">{WHAT}</div>

      <section className="server-group">
        <h3>Download a backup</h3>
        <div className="hint">A file protected with a password you choose. It restores here or on another DreyMail server.</div>
        <div className="cal-when-row">
          <input className="input" type="password" autoComplete="new-password" placeholder="Backup password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input className="input" type="password" autoComplete="new-password" placeholder="Same password again" value={password2} onChange={(e) => setPassword2(e.target.value)} />
        </div>
        <div className="cal-when-row">
          <button className="btn primary" disabled={!!busy || !password} onClick={() => void download()}>
            {busy === 'download' ? 'Preparing…' : 'Download backup'}
          </button>
        </div>
      </section>

      <section className="server-group">
        <h3>Restore from a file</h3>
        <input ref={fileInput} type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <div className="cal-when-row">
          <input className="input" type="password" autoComplete="off" placeholder="The backup's password" value={filePassword} onChange={(e) => setFilePassword(e.target.value)} />
          <button className="btn" disabled={!!busy || !file || !filePassword} onClick={() => void restoreFile()}>
            {busy === 'file' ? 'Restoring…' : 'Restore'}
          </button>
        </div>
      </section>

      <section className="server-group">
        <h3>Automatic backups</h3>
        {auto.data && auto.data.keepDays === 0 ? (
          <div className="hint">This server doesn&apos;t make automatic backups.</div>
        ) : (
          <>
            <div className="hint">This server keeps a copy every day{auto.data ? ` for ${auto.data.keepDays} days` : ''}. Restoring one puts back your data as it was then.</div>
            {auto.data?.backups.length === 0 && <div className="hint">None yet.</div>}
            <ul className="user-list">
              {(auto.data?.backups ?? []).map((s) => (
                <li key={s.name}>
                  <div className="user-main">
                    <div className="user-name">{new Date(s.createdAt).toLocaleString()}</div>
                  </div>
                  <button className="btn" disabled={!!busy} onClick={() => void restoreAuto(s)}>
                    {busy === s.name ? 'Restoring…' : 'Restore'}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {message && <div className={message.error ? 'error-text' : 'muted'}>{message.text}</div>}
    </div>
  );
}
