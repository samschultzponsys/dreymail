// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Settings → Backup (DreyMail 11.9): download your data as a password-protected file, restore it
// (here or on another DreyMail server), or restore from the server's automatic daily backups.
// DreyMail 12.0: this device's own settings, saved on a schedule or by hand, as a file too.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { fetchJson } from '../api';
import { applyDeviceSettings, deviceId, deviceName, deviceSchedule, saveDeviceSettings, setDeviceName, setDeviceSchedule, type DeviceSchedule } from '../deviceBackup';

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
      <section className="server-group">
        <h3>Your account</h3>
        <div className="hint">{WHAT}</div>
      </section>

      <DeviceBackup />

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

type SavedDevice = { deviceId: string; name: string; kind: string; savedAt: string; bytes: number };

/**
 * This device's own settings (interface size, layout, the Android app's notification icons, …):
 * saved to the server on a schedule or now, downloaded as a file, and restored from a saved device
 * or a file (DreyMail 12.0).
 */
function DeviceBackup() {
  const qc = useQueryClient();
  const saved = useQuery({ queryKey: ['device-backups'], queryFn: () => fetchJson<SavedDevice[]>('GET', '/api/device-backups') });
  const [schedule, setSchedule] = useState<DeviceSchedule>(deviceSchedule);
  const [name, setName] = useState(deviceName);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const me = deviceId();

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
  const saveNow = () =>
    run('save', async () => {
      await saveDeviceSettings();
      setSchedule(deviceSchedule());
      void qc.invalidateQueries({ queryKey: ['device-backups'] });
      setMessage({ text: 'This device’s settings are saved.' });
    });
  const apply = (data: unknown) => {
    applyDeviceSettings(data);
    setMessage({ text: 'Restored. Reloading…' });
    setTimeout(() => window.location.reload(), 800);
  };
  const restoreSaved = (d: SavedDevice) =>
    run(d.deviceId, async () => {
      if (!confirm(`Use the settings saved from “${d.name}” (${new Date(d.savedAt).toLocaleString()}) on this device?`)) return;
      apply((await fetchJson<{ data: unknown }>('GET', `/api/device-backups/${d.deviceId}`)).data);
    });
  const download = () =>
    run('download', async () => {
      await saveDeviceSettings();
      void qc.invalidateQueries({ queryKey: ['device-backups'] });
      const a = document.createElement('a');
      a.href = `/api/device-backups/${me}/file`;
      a.download = '';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  const restoreFile = (file: File) =>
    run('file', async () => {
      const data = JSON.parse(await file.text()) as unknown;
      if (!confirm('Use the settings from this file on this device?')) return;
      apply(data);
    });
  const remove = (d: SavedDevice) =>
    run(`x${d.deviceId}`, async () => {
      if (!confirm(`Forget the settings saved from “${d.name}”?`)) return;
      await fetchJson('DELETE', `/api/device-backups/${d.deviceId}`);
      void qc.invalidateQueries({ queryKey: ['device-backups'] });
    });

  return (
    <section className="server-group">
      <h3>This device</h3>
      <div className="hint">
        What this device keeps for itself: interface size, layout, the folder bar, the Android app&apos;s notification icons and the desktop app&apos;s tray
        setting. Saved on the server, it comes back after reinstalling the app or on a new phone or computer. The schedule runs while DreyMail is open.
      </div>
      <div className="cal-when-row">
        <input
          className="input"
          aria-label="This device's name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            setDeviceName(name);
            setName(deviceName());
          }}
        />
        <select
          className="select"
          aria-label="Save this device's settings"
          value={schedule.every}
          onChange={(e) => {
            const next = { ...schedule, every: e.target.value as DeviceSchedule['every'] };
            setDeviceSchedule(next);
            setSchedule(next);
          }}
        >
          <option value="off">Save by hand</option>
          <option value="daily">Save every day</option>
          <option value="weekly">Save every week</option>
        </select>
      </div>
      <div className="cal-when-row">
        <button className="btn primary" disabled={!!busy} onClick={() => void saveNow()}>
          {busy === 'save' ? 'Saving…' : 'Save now'}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => void download()}>
          Download as a file
        </button>
        <button className="btn" disabled={!!busy} onClick={() => fileInput.current?.click()}>
          Restore from a file
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void restoreFile(f);
          }}
        />
      </div>
      {schedule.last > 0 && <div className="hint">Last saved {new Date(schedule.last).toLocaleString()}.</div>}
      {(saved.data ?? []).length > 0 && (
        <>
          <div className="label">Saved devices</div>
          <ul className="user-list">
            {(saved.data ?? []).map((d) => (
              <li key={d.deviceId}>
                <div className="user-main">
                  <div className="user-name">
                    {d.name || d.kind}
                    {d.deviceId === me ? ' (this device)' : ''}
                  </div>
                  <div className="muted user-meta">Saved {new Date(d.savedAt).toLocaleString()}</div>
                </div>
                <button className="btn" disabled={!!busy} onClick={() => void restoreSaved(d)}>
                  {d.deviceId === me ? 'Restore' : 'Use here'}
                </button>
                <button className="icon-btn" title="Forget" disabled={!!busy} onClick={() => void remove(d)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {message && <div className={message.error ? 'error-text' : 'muted'}>{message.text}</div>}
    </section>
  );
}
