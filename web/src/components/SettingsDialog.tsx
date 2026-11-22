// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: user-visible name changed from "Ratatoskr" to "DreyMail".
// Modified by samschultzponsys, 2026-11-13: All inboxes on/off setting.
// Modified by samschultzponsys, 2026-11-13: tabs (General, Signatures, Notifications, Images, Password).
// Modified by samschultzponsys, 2026-11-13: Users and Sign-in tabs for administrators.
// Modified by samschultzponsys, 2026-11-13: label capitalization.
// Modified by samschultzponsys, 2026-11-13: desktop app: native notifications, update check.
// Modified by samschultzponsys, 2026-11-13: Android app: notifications and Firebase settings.
// Modified by samschultzponsys, 2026-11-13: Android: change server.
// Modified by samschultzponsys, 2026-11-13: your name; interface size.
// Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.
// Modified by samschultzponsys, 2026-11-15: Outlook accounts; This device settings.
// Modified by samschultzponsys, 2026-11-15: Sign in with Google for Gmail.
// Modified by samschultzponsys, 2026-11-15: roles and permissions, profile pictures, grouped settings, empty mailbox screen.
// Modified by samschultzponsys, 2026-11-15: choose what the bottom left shows (photo, name or both).
// Modified by samschultzponsys, 2026-11-15: American spelling.
// Modified by samschultzponsys, 2026-11-15: AI mailbox assistant.
// Modified by samschultzponsys, 2026-11-15: source code link; AI cleanup.
// Modified by samschultzponsys, 2026-11-15: copy codes, unsubscribe, block sender, mailbox health.
// Modified by samschultzponsys, 2026-11-15: send later and undo send.
// Modified by samschultzponsys, 2026-11-15: passkey sign-in.
// Modified by samschultzponsys, 2026-11-15: automatic inbox tabs.
// Modified by samschultzponsys, 2026-11-15: connect single sign-on in Profile.
// Modified by samschultzponsys, 2026-11-16: automatic image rules; sidebar entries to show.
// Modified by samschultzponsys, 2026-11-16: "Show in notifications" in the Android app too.
// Modified by samschultzponsys, 2026-11-16: notifications can show the start of the message.
// Modified by samschultzponsys, 2026-11-16: clicking outside no longer closes it (it lost what was typed).
// Modified by samschultzponsys, 2026-11-16: desktop app: minimize to the tray.
// Modified by samschultzponsys, 2026-11-16: buttons pinned to each message.
// Modified by samschultzponsys, 2026-11-17: send delay presets up to 5 minutes and a custom delay up to 10.
// Modified by samschultzponsys, 2026-11-17: pinned message buttons apply to every message.
// Modified by samschultzponsys, 2026-11-17: Auto-replies tab.
// Modified by samschultzponsys, 2026-11-17: Install the app (This device, in a browser).
// Modified by samschultzponsys, 2026-11-17: stay signed in and the idle lock (This device); Server settings.
// Modified by samschultzponsys, 2026-11-17: Storage tab (space used per user).
// Modified by samschultzponsys, 2026-11-17: address suggestions and Cc/Bcc lines in General.
// Modified by samschultzponsys, 2026-11-19: Android: notifications as conversations (the mailbox's icon on the left); which icon on each side.
// Modified by samschultzponsys, 2026-11-21: the Backup tab.
// Modified by samschultzponsys, 2026-11-22: opens on a given tab (the search at the top); images in all mail, or from everyone you know.
// Modified by samschultzponsys, 2026-11-23: the Search and storage tab.

import { DeviceSessionSettings } from './AppLock';
import { ServerAdmin } from './ServerAdmin';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Permission } from '../../../shared/permissions';
import { DEFAULT_MESSAGE_BUTTONS, type DomainName, type Me, type MessageButton, type NotificationContent, type Preferences, type SwipeAction, type TransitionSpeed } from '../../../shared/types';
import { api } from '../api';
import { desktopBridge, mailboxNotificationIcon } from '../desktop';
import { effectiveUiScale, saveUiScale, savedUiScale, UI_SCALES, type UiScale } from '../uiScale';
import { SignaturesSettings } from './SignaturesSettings';
import { AndroidAdmin, GoogleAdmin, OutlookAdmin, RolesAdmin, SignInAdmin, UsersAdmin } from './AdminSettings';
import { StorageAdmin } from './StorageAdmin';
import { WritingSettings } from './WritingSettings';
import { ProfilePicture } from './UserPicture';
import { AiConnections } from './AiConnections';
import { SourceLink } from './SourceLink';
import { Passkeys } from './Passkeys';
import { SingleSignOn } from './SingleSignOn';
import { AutoRepliesSettings } from './AutoReplies';
import { BackupSettings } from './BackupSettings';
import { CacheSettings } from './CacheSettings';
import { InstallDialog } from './InstallDialog';
import { runningAsApp } from '../install';
import { androidBridge, androidInfo } from '../android';
import { useAccounts } from '../hooks';
import { handlerTemplate } from '../mailto';
import { currentEnvironment, currentSubscription, disablePush, enablePush, pushAvailability, type PushAvailability } from '../push';
import { formatDelay } from '../util';

const TRANSITION_OPTIONS: [TransitionSpeed, string][] = [
  ['off', 'Off'],
  ['slide', 'Slide'],
  ['fast', 'Squirrel, fast'],
  ['medium', 'Squirrel, medium'],
  ['slow', 'Squirrel, slow'],
];

const SWIPE_OPTIONS: [SwipeAction, string][] = [
  ['none', 'Nothing'],
  ['archive', 'Archive'],
  ['delete', 'Delete'],
  ['toggleRead', 'Mark read / unread'],
  ['toggleFlag', 'Flag / unflag'],
];

type SettingsTab = 'device' | 'ai' | 'profile' | 'general' | 'signatures' | 'autoreplies' | 'notifications' | 'privacy' | 'password' | 'users' | 'storage' | 'roles' | 'signin' | 'server' | 'outlook' | 'google' | 'android' | 'backup' | 'cache';

/** The Settings tabs this user has (DreyMail 12.1: the search at the top only offers these). */
export function settingTabsFor(me: Me): string[] {
  const can = (p: Permission) => me.permissions.includes(p);
  return [
    'device',
    'profile',
    'general',
    'signatures',
    'autoreplies',
    'privacy',
    'backup',
    'cache',
    ...(me.hasPassword ? ['password'] : []),
    ...(can('ai.assistant') ? ['ai'] : []),
    ...(can('users.manage') || can('users.pictures') || can('roles.manage') ? ['users'] : []),
    ...(can('users.manage') ? ['storage'] : []),
    ...(can('roles.manage') ? ['roles'] : []),
    ...(can('signin.manage') ? ['signin'] : []),
    ...(can('server.manage') ? ['server'] : []),
    ...(can('providers.manage') ? ['outlook', 'google'] : []),
    ...(can('android.manage') ? ['android'] : []),
  ];
}

export function SettingsDialog({ me, onClose, initialTab = null }: { me: Me; onClose: () => void; initialTab?: string | null }) {
  const qc = useQueryClient();
  const prefs = me.preferences;
  const can = (p: Permission) => me.permissions.includes(p);
  const [v, setV] = useState(prefs);
  const [error, setError] = useState<string | null>(null);
  const versionQ = useQuery({ queryKey: ['version'], queryFn: api.version, staleTime: 3600_000 });
  const aiStatus = useQuery({ queryKey: ['ai', 'status'], queryFn: api.assistantStatus, staleTime: 60_000 });
  const myAccounts = useAccounts();
  // Grouped under headings: what is stored on this device, what belongs to your account (every
  // device), and administration (what your role allows).
  type TabGroup = { label: string; tabs: [SettingsTab, string][] };
  const groups = ([
    { label: 'This device', tabs: [['device', 'This device']] },
    {
      label: 'Your account',
      tabs: [
        ['profile', 'Profile'] as [SettingsTab, string],
        ['general', 'General'] as [SettingsTab, string],
        ['signatures', 'Signatures'] as [SettingsTab, string],
        ['autoreplies', 'Auto-replies'] as [SettingsTab, string],
        ['privacy', 'Images'] as [SettingsTab, string],
        ...(me.hasPassword ? [['password', 'Password'] as [SettingsTab, string]] : []),
        ...(aiStatus.data?.allowed ? [['ai', 'AI connections'] as [SettingsTab, string]] : []),
        ['cache', 'Search and storage'] as [SettingsTab, string],
        ['backup', 'Backup'] as [SettingsTab, string],
      ],
    },
    {
      label: 'Administration',
      tabs: [
        ...(can('users.manage') || can('users.pictures') || can('roles.manage') ? [['users', 'Users'] as [SettingsTab, string]] : []),
        ...(can('users.manage') ? [['storage', 'Storage'] as [SettingsTab, string]] : []),
        ...(can('roles.manage') ? [['roles', 'Roles'] as [SettingsTab, string]] : []),
        ...(can('signin.manage') ? [['signin', 'Sign-in'] as [SettingsTab, string]] : []),
        ...(can('server.manage') ? [['server', 'Server'] as [SettingsTab, string]] : []),
        ...(can('providers.manage') ? ([['outlook', 'Outlook'], ['google', 'Google']] as [SettingsTab, string][]) : []),
        ...(can('android.manage') ? [['android', 'Android'] as [SettingsTab, string]] : []),
      ],
    },
  ] as TabGroup[]).filter((g) => g.tabs.length > 0);
  const [tab, setTab] = useState<SettingsTab>(() => (initialTab && groups.some((g) => g.tabs.some(([k]) => k === initialTab)) ? (initialTab as SettingsTab) : 'device'));

  const save = async (next: Preferences) => {
    setV(next);
    try {
      await api.savePreferences(next);
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['messages'] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="overlay">
      {/* No closing on a click outside: it would lose what was typed. Close with × or Cancel. */}
      <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(640px, 100%)', height: 'min(720px, calc(100dvh - 32px))' }}>
        <div className="dialog-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="tabs grouped" role="tablist">
          {groups.map((g) => (
            <div className="tab-group" key={g.label} role="group" aria-label={g.label}>
              <span className="tab-group-label">{g.label}</span>
              <div className="tab-group-tabs">
                {g.tabs.map(([key, label]) => (
                  <button key={key} role="tab" aria-selected={tab === key} className={`tab ${tab === key ? 'on' : ''}`} onClick={() => setTab(key)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="dialog-body">
          {tab === 'general' && (
            <>
              <div>
                <label className="label">Appearance</label>
                <div className="segmented">
                  {(['system', 'light', 'dark'] as const).map((t) => (
                    <button key={t} className={v.theme === t ? 'on' : ''} onClick={() => void save({ ...v, theme: t })} style={{ padding: '6px 14px' }}>
                      {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="label">Messages per page</label>
                <select className="select" value={v.pageSize} onChange={(e) => void save({ ...v, pageSize: Number(e.target.value) })}>
                  {[25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid2">
                {(['swipeRight', 'swipeLeft'] as const).map((key) => (
                  <div key={key}>
                    <label className="label">{key === 'swipeRight' ? 'Swipe right' : 'Swipe left'}</label>
                    <select className="select" value={v[key]} onChange={(e) => void save({ ...v, [key]: e.target.value as SwipeAction })}>
                      {SWIPE_OPTIONS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div>
                <label className="check">
                  <input type="checkbox" checked={v.unifiedInbox} onChange={(e) => void save({ ...v, unifiedInbox: e.target.checked })} />
                  Show “All inboxes”
                </label>
                <div className="hint">One list of every account’s inbox. Turn it off to keep accounts completely separate; DreyMail then opens on your first account.</div>
              </div>
              <label className="check">
                <input type="checkbox" checked={v.markReadOnOpen} onChange={(e) => void save({ ...v, markReadOnOpen: e.target.checked })} />
                Mark messages as read when opened
              </label>
              <div>
                <label className="check">
                  <input type="checkbox" checked={v.contactPhotos} onChange={(e) => void save({ ...v, contactPhotos: e.target.checked })} />
                  Show contact pictures
                </label>
                <div className="hint">
                  From Gravatar, Libravatar or the sender's website, fetched by the server so they never see your IP address. Otherwise initials are shown.
                </div>
              </div>
              <div>
                <label className="label" htmlFor="screen-transitions">
                  Screen transitions
                </label>
                <select
                  id="screen-transitions"
                  className="select"
                  value={v.screenTransitions}
                  onChange={(e) => void save({ ...v, screenTransitions: e.target.value as TransitionSpeed })}
                >
                  {TRANSITION_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <div className="hint">On phones, when you open the menu or a message: the new view slides in, or a squirrel runs across the screen and pulls it in.</div>
              </div>
            </>
          )}
          {tab === 'profile' && (
            <>
              <ProfilePicture me={me} />
              <Passkeys />
              <SingleSignOn />
              <YourName />
              <FullNameToggle v={v} save={save} />
              <div className="hint">
                Your role: <strong>{me.role.name}</strong>
              </div>
              <SourceLink version={versionQ.data?.version} />
            </>
          )}
          {tab === 'general' && (
            <div>
              <label className="label">Sidebar shows</label>
              <div className="check-list">
                <label className="check">
                  <input type="checkbox" checked={v.sidebarCalendar ?? true} onChange={(e) => void save({ ...v, sidebarCalendar: e.target.checked })} /> Calendar
                </label>
                <label className="check">
                  <input type="checkbox" checked={v.sidebarScheduled ?? true} onChange={(e) => void save({ ...v, sidebarScheduled: e.target.checked })} /> Scheduled
                  (when mail is waiting to be sent)
                </label>
                <label className="check">
                  <input type="checkbox" checked={v.sidebarSearches ?? true} onChange={(e) => void save({ ...v, sidebarSearches: e.target.checked })} /> Saved searches
                </label>
              </div>
              <div className="hint">Folders can be pinned in the sidebar itself (the pin next to each folder).</div>
            </div>
          )}
          {tab === 'general' && (
            <div>
              <label className="label">Buttons pinned to each message</label>
              <div className="check-list">
                {(
                  [
                    ['reply', 'Reply'],
                    ['replyAll', 'Reply all'],
                    ['forward', 'Forward'],
                    ['seen', 'Mark read / unread'],
                    ['flag', 'Flag'],
                    ['archive', 'Archive'],
                    ['delete', 'Delete'],
                  ] as [MessageButton, string][]
                ).map(([b, label]) => {
                  const pinned = v.messageButtons ?? DEFAULT_MESSAGE_BUTTONS;
                  return (
                    <label key={b} className="check">
                      <input
                        type="checkbox"
                        checked={pinned.includes(b)}
                        onChange={(e) => void save({ ...v, messageButtons: e.target.checked ? [...pinned, b] : pinned.filter((x) => x !== b) })}
                      />{' '}
                      {label}
                    </label>
                  );
                })}
              </div>
              <div className="hint">Small buttons in the header of every opened message (also single messages and each message of a conversation) that act on that message only. The bar at the top acts on the whole conversation; the arrow at its right end makes its buttons bigger, with names.</div>
            </div>
          )}
          {tab === 'general' && (
            <label className="check">
              <input type="checkbox" checked={v.inboxTabs ?? false} onChange={(e) => void save({ ...v, inboxTabs: e.target.checked })} />
              Split the inbox into Personal, Updates and Newsletters tabs
            </label>
          )}
          {tab === 'general' && <WritingSettings prefs={v} save={(p) => void save(p)} accounts={myAccounts.data ?? []} />}
          {tab === 'general' && (
            <SendDelay value={v.undoSendSeconds ?? 10} onChange={(n) => void save({ ...v, undoSendSeconds: n })} />
          )}
          {tab === 'general' && <BlockedSenders accounts={myAccounts.data ?? []} />}
          {tab === 'ai' && <AiConnections accounts={myAccounts.data ?? []} canShare={!!aiStatus.data?.canShare} />}
          {tab === 'signatures' && <SignaturesSettings />}
          {tab === 'autoreplies' && <AutoRepliesSettings />}
          {tab === 'device' && <ThisDevice prefs={v} save={save} />}
          {tab === 'server' && <ServerAdmin />}
          {tab === 'backup' && <BackupSettings />}
          {tab === 'cache' && <CacheSettings prefs={v} save={save} />}
          {tab === 'privacy' && (
            <div>
              <label className="label">Load images by themselves</label>
              <div className="check-list">
                <label className="check">
                  <input type="checkbox" checked={v.imagesEveryone ?? false} onChange={(e) => void save({ ...v, imagesEveryone: e.target.checked })} />
                  In all mail <span className="muted">(not in Junk)</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={v.imagesOwnDomains ?? true} onChange={(e) => void save({ ...v, imagesOwnDomains: e.target.checked })} />
                  In mail from your own domains <span className="muted">(the domains of your mailboxes)</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={v.imagesContacts ?? true} onChange={(e) => void save({ ...v, imagesContacts: e.target.checked })} />
                  In mail from people you know <span className="muted">(you wrote to them, they wrote to you, or they are in your contacts)</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={v.imagesSenderHosted ?? false} onChange={(e) => void save({ ...v, imagesSenderHosted: e.target.checked })} />
                  When all images are on the sender&apos;s own domain
                </label>
              </div>
              <div className="hint">
                Images are never a danger to your device: DreyMail fetches and checks them itself, so senders never see your address. Loading them only lets a
                sender see that you opened the mail (tracking pixels), which is why &quot;In all mail&quot; is off unless you turn it on. Mail in Junk, and mail that
                fails the sender check (DMARC), never loads images by itself.
              </div>
            </div>
          )}
          {tab === 'privacy' && <ImageDomains />}
          {tab === 'password' && <ChangePassword />}
          {tab === 'users' && <UsersAdmin me={me} />}
          {tab === 'storage' && <StorageAdmin />}
          {tab === 'roles' && <RolesAdmin me={me} />}
          {tab === 'signin' && <SignInAdmin />}
          {tab === 'outlook' && <OutlookAdmin />}
          {tab === 'google' && <GoogleAdmin />}
          {tab === 'android' && <AndroidAdmin />}
          {error && <div className="error-text">{error}</div>}
        </div>
      </div>
    </div>
  );
}

const SEND_DELAYS = [0, 10, 30, 60, 120, 300];
const MAX_SEND_DELAY = 600;

/** Settings → General → Send delay: presets, or any custom delay up to 10 minutes. */
function SendDelay({ value, onChange }: { value: number; onChange: (seconds: number) => void }) {
  const preset = SEND_DELAYS.includes(value);
  const [custom, setCustom] = useState(!preset);
  const [minutes, setMinutes] = useState(String(Math.floor(value / 60)));
  const [seconds, setSeconds] = useState(String(value % 60));
  const apply = (m: string, s: string) => {
    const total = Math.min(MAX_SEND_DELAY, Math.max(0, (parseInt(m, 10) || 0) * 60 + (parseInt(s, 10) || 0)));
    if (total !== value) onChange(total);
  };
  return (
    <div>
      <label className="label">Send delay (undo send)</label>
      <div className="segmented" style={{ flexWrap: 'wrap' }}>
        {SEND_DELAYS.map((n) => (
          <button
            key={n}
            className={!custom && value === n ? 'on' : ''}
            onClick={() => {
              setCustom(false);
              onChange(n);
            }}
            style={{ padding: '6px 12px' }}
          >
            {n === 0 ? 'Off' : formatDelay(n)}
          </button>
        ))}
        <button className={custom ? 'on' : ''} onClick={() => setCustom(true)} style={{ padding: '6px 12px' }}>
          Custom
        </button>
      </div>
      {custom && (
        <div className="send-delay-custom">
          <input className="input" type="number" min={0} max={10} value={minutes} aria-label="Minutes" onChange={(e) => setMinutes(e.target.value)} onBlur={() => apply(minutes, seconds)} />
          <span>min</span>
          <input className="input" type="number" min={0} max={59} value={seconds} aria-label="Seconds" onChange={(e) => setSeconds(e.target.value)} onBlur={() => apply(minutes, seconds)} />
          <span>s</span>
          <span className="muted">up to 10 minutes{value ? ` · now ${formatDelay(value)}` : ''}</span>
        </div>
      )}
      <div className="hint">
        After you press Send, the message waits this long so you can take it back with Undo (it's listed under Scheduled meanwhile). Your server sends it
        even if you close DreyMail. To send at a later time, use Schedule next to Send.
      </div>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setDone(false);
    if (next !== confirm) return setError('New passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="password-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="label">Change password</label>
      <input type="text" name="username" autoComplete="username" hidden readOnly />
      <input className="input" type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" required maxLength={1000} value={current} onChange={(e) => setCurrent(e.target.value)} />
      <input className="input" type="password" autoComplete="new-password" placeholder="New password (at least 10 characters)" aria-label="New password" required minLength={10} maxLength={256} value={next} onChange={(e) => setNext(e.target.value)} />
      <input className="input" type="password" autoComplete="new-password" placeholder="Repeat new password" aria-label="Repeat new password" required maxLength={256} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <div>
        <button className="btn" type="submit" disabled={busy}>
          Change password
        </button>
      </div>
      {done && <div className="hint">Password changed.</div>}
      {error && <div className="error-text">{error}</div>}
    </form>
  );
}

/** Sender domains whose mail loads remote images automatically (subdomains included). */
function ImageDomains() {
  const qc = useQueryClient();
  const domains = useQuery({ queryKey: ['imageDomains'], queryFn: api.imageDomains });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (run: () => Promise<DomainName[]>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['imageDomains'], await run());
      await qc.invalidateQueries({ queryKey: ['message'] });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (input.trim() && (await change(() => api.addImageDomain(input.trim())))) setInput('');
  };

  return (
    <div>
      <label className="label">Always load images from</label>
      {domains.data && domains.data.length > 0 ? (
        <ul className="domain-list">
          {domains.data.map((d) => (
            <li key={d.domain}>
              <span title={d.display !== d.domain ? d.domain : undefined}>{d.display}</span>
              <button className="icon-btn" disabled={busy} title={`Remove ${d.display}`} onClick={() => void change(() => api.removeImageDomain(d.domain))}>
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="hint">{domains.isLoading ? 'Loading…' : 'No domains yet. Images from other senders stay blocked until you load them.'}</div>
      )}
      <form
        className="domain-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="example.com" aria-label="Domain to allow" maxLength={300} />
        <button className="btn" type="submit" disabled={busy || !input.trim()}>
          Add
        </button>
      </form>
      <div className="hint">Also covers subdomains. Not applied to messages that fail the sender check (DMARC).</div>
      {(error || domains.error) && <div className="error-text">{error ?? (domains.error as Error).message}</div>}
    </div>
  );
}

/** Ask the browser to open mailto: links (on any website) in DreyMail. */
function EmailLinks() {
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = window.isSecureContext && typeof navigator.registerProtocolHandler === 'function';

  const register = () => {
    setError(null);
    try {
      navigator.registerProtocolHandler('mailto', handlerTemplate(window.location.origin));
      setAsked(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      <label className="label">Email links</label>
      {supported ? (
        <>
          <button className="btn" onClick={register}>
            Open email links with DreyMail
          </button>
          <div className="hint">
            {asked
              ? 'Confirm in your browser’s prompt (some browsers show it as an icon in the address bar). You can undo this in the browser’s settings.'
              : 'Makes mailto: links on any website open a new message here. Links in your mail always do.'}
          </div>
        </>
      ) : (
        <div className="hint">
          {window.isSecureContext
            ? 'This browser can’t send mailto: links on other websites to DreyMail. Links in your mail still open a new message here.'
            : 'Opening mailto: links from other websites needs the app to be served over HTTPS.'}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/** Web Push on this device, plus how much the notifications may reveal (a per-user preference). */
function Notifications({ prefs, save }: { prefs: Preferences; save: (p: Preferences) => Promise<void> }) {
  const [availability, setAvailability] = useState<PushAvailability>(() => pushAvailability(currentEnvironment()));
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (availability !== 'available') return setEnabled(false);
    void currentSubscription()
      .then((sub) => setEnabled(!!sub && Notification.permission === 'granted'))
      .catch(() => setEnabled(false));
  }, [availability]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setAvailability(pushAvailability(currentEnvironment()));
    }
  };

  const toggle = (on: boolean) =>
    run(async () => {
      if (on) await enablePush();
      else await disablePush();
      setEnabled(on);
    });

  const test = () =>
    run(async () => {
      const { delivered } = await api.testPush();
      setInfo(delivered > 0 ? `Sent to ${delivered} device${delivered === 1 ? '' : 's'}.` : 'No device accepted the notification.');
    });

  return (
    <div>
      <label className="label">Notifications</label>
      {availability === 'needs-install' && (
        <div className="hint">
          On iPhone and iPad, notifications only work once DreyMail is on your Home Screen. Tap the Share button, choose
          “Add to Home Screen”, then open DreyMail from there and come back here.
        </div>
      )}
      {availability === 'denied' && (
        <div className="hint">Notifications are blocked for this site. Allow them in your browser’s site settings, then reopen this dialog.</div>
      )}
      {availability === 'unsupported' && (
        <div className="hint">
          {window.isSecureContext ? 'This browser does not support notifications.' : 'Notifications need the app to be served over HTTPS.'}
        </div>
      )}
      {availability === 'available' && (
        <div className="notify-row">
          <label className="check">
            <input type="checkbox" checked={!!enabled} disabled={busy || enabled === null} onChange={(e) => void toggle(e.target.checked)} />
            Notify me about new mail on this device
          </label>
          {enabled && (
            <button className="btn" disabled={busy} onClick={() => void test()}>
              Send test
            </button>
          )}
        </div>
      )}
      <NotificationContentSelect prefs={prefs} save={save} />
      <div className="hint">
        You get a notification for new unread mail in your inboxes while DreyMail isn’t open in front of you. Notifications pass through
        Apple’s or Google’s push service, encrypted so that only your device can read them.
      </div>
      {info && <div className="hint">{info}</div>}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/** What a notification shows (account-wide: the server builds the notification for every device). */
function NotificationContentSelect({ prefs, save }: { prefs: Preferences; save: (p: Preferences) => Promise<void> }) {
  return (
    <div style={{ marginTop: 10 }}>
      <label className="label" htmlFor="notify-content">
        Show in notifications
      </label>
      <select
        id="notify-content"
        className="select"
        value={prefs.notificationContent}
        onChange={(e) => void save({ ...prefs, notificationContent: e.target.value as NotificationContent })}
      >
        <option value="full">Sender and subject</option>
        <option value="preview">Sender, subject and the start of the message</option>
        <option value="minimal">Only “New message” and the account</option>
      </select>
    </div>
  );
}

/** Settings → General, in the DreyMail desktop or Android app only: its version and an update check. */
function DesktopApp() {
  const desktop = desktopBridge();
  const android = androidInfo();
  const info = desktop ?? android;
  if (!info) return null;
  return (
    <div>
      <label className="label">{desktop ? 'Desktop app' : 'Android app'}</label>
      <div className="row-buttons">
        <span>
          DreyMail {info.version} <span className="muted">({info.installKind})</span>
        </span>
        <button className="btn" onClick={() => (desktop ? desktop.checkForUpdates() : androidBridge()?.checkForUpdates())}>
          Check for updates
        </button>
        <button className="btn" onClick={() => (desktop ? desktop.changeServer() : androidBridge()?.changeServer())}>
          Change server
        </button>
      </div>
      <div className="hint">Updates are also checked every time the app starts.</div>
    </div>
  );
}

/** Desktop app: one sample notification per mailbox, to see each one's color and icon. */
function DesktopTestNotifications() {
  const accounts = useAccounts();
  const desktop = desktopBridge();
  if (!desktop) return null;
  return (
    <div className="row-buttons" style={{ marginTop: 6 }}>
      <button
        className="btn"
        onClick={() => {
          for (const a of accounts.data ?? []) {
            desktop.notify({
              title: `Test · ${a.name}`,
              body: 'This is how new mail for this mailbox looks.',
              tag: `test:${a.id}`,
              url: '/',
              icon: mailboxNotificationIcon(a, '#22d3ee'),
            });
          }
        }}
      >
        Send a test notification for each mailbox
      </button>
    </div>
  );
}

/** Desktop app: minimizing sends the window to the tray; a click on the tray icon brings it back. */
function TrayOption() {
  const desktop = desktopBridge();
  const [on, setOn] = useState(!!desktop?.minimizeToTray);
  if (!desktop?.setMinimizeToTray) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <label className="label">Window</label>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            desktop.setMinimizeToTray?.(e.target.checked);
          }}
        />
        Minimize to the tray
      </label>
      <div className="hint">
        Minimizing hides DreyMail from the taskbar; click the tray icon to bring it back, and click it again to send it away. Closing the window
        always keeps DreyMail running in the tray (Quit is in the tray menu).
      </div>
    </div>
  );
}

/** Settings → Notifications in the Android app: Android's own per-account settings (sound, vibration). */
function AndroidNotifications() {
  const accounts = useAccounts();
  const bridge = androidBridge()!;
  return (
    <div className="stack">
      <div className="hint">
        New mail arrives the moment it lands, as a notification in the account’s color. Each account has its own Android notification channel: pick a
        different sound, vibration or importance for each one.
      </div>
      {bridge.setNotificationIcons ? <NotificationIcons bridge={bridge} /> : bridge.setConversations && <ConversationSetting bridge={bridge} />}
      <ul className="user-list">
        {(accounts.data ?? []).map((a) => (
          <li key={a.id}>
            <span className="dot" style={{ background: a.color, width: 12, height: 12 }} />
            <div className="user-main">
              <div className="user-name">{a.name}</div>
              <div className="muted user-meta">{a.email}</div>
            </div>
            <button className="btn" onClick={() => bridge.openChannelSettings(a.id)}>
              Sound and vibration
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Android: new-mail notifications as conversations, with the mailbox's icon on the left (DreyMail 11.4). */
function ConversationSetting({ bridge }: { bridge: NonNullable<ReturnType<typeof androidBridge>> }) {
  const [on, setOn] = useState(() => {
    try {
      return !!bridge.conversations?.();
    } catch {
      return false;
    }
  });
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          bridge.setConversations!(e.target.checked);
          setOn(e.target.checked);
        }}
      />
      <span>
        Show the mailbox&apos;s icon on notifications
        <span className="hint" style={{ display: 'block' }}>
          New mail shows as a conversation: the mailbox&apos;s icon on the left instead of DreyMail&apos;s, in Android&apos;s Conversations section above other
          apps. Long-press one to make that mailbox a priority conversation. Applies to new notifications.
        </span>
      </span>
    </label>
  );
}

/** Android: which icon new-mail notifications show on each side (DreyMail 11.5). */
function NotificationIcons({ bridge }: { bridge: NonNullable<ReturnType<typeof androidBridge>> }) {
  const [v, setV] = useState<{ left: string; right: string }>(() => {
    try {
      return JSON.parse(bridge.notificationIcons!()) as { left: string; right: string };
    } catch {
      return { left: 'app', right: 'mailbox' };
    }
  });
  const set = (next: { left: string; right: string }) => {
    bridge.setNotificationIcons!(next.left, next.right);
    setV(next);
  };
  return (
    <div className="stack">
      <div>
        <label className="label" htmlFor="notif-left">
          Icon on the left
        </label>
        <select id="notif-left" className="select" value={v.left} onChange={(e) => set({ ...v, left: e.target.value })}>
          <option value="app">DreyMail&apos;s icon</option>
          <option value="mailbox">The mailbox&apos;s icon</option>
          <option value="group">The group&apos;s icon</option>
          <option value="color">The mailbox&apos;s color</option>
        </select>
        <div className="hint">
          Anything but DreyMail&apos;s icon sends new mail as an Android conversation: it shows in the Conversations section above other apps, and a long-press
          makes a mailbox a priority conversation.
        </div>
      </div>
      <div>
        <label className="label" htmlFor="notif-right">
          Icon on the right
        </label>
        <select id="notif-right" className="select" value={v.right} onChange={(e) => set({ ...v, right: e.target.value })}>
          <option value="mailbox">The mailbox&apos;s icon</option>
          <option value="group">The group&apos;s icon</option>
          <option value="color">The mailbox&apos;s color</option>
          <option value="none">None</option>
        </select>
      </div>
      <div className="hint">
        A mailbox without an icon of its own (a color dot) shows an envelope in its color; the group&apos;s icon falls back to the mailbox&apos;s. Applies to new
        notifications.
      </div>
    </div>
  );
}

/** Interface size for this device only. */
function InterfaceSize() {
  const [scale, setScale] = useState<UiScale>(savedUiScale);
  return (
    <div>
      <label className="label" htmlFor="ui-scale">
        Interface size
      </label>
      <select
        id="ui-scale"
        className="select"
        value={String(scale)}
        onChange={(e) => {
          const next: UiScale = e.target.value === 'auto' ? 'auto' : Number(e.target.value);
          setScale(next);
          saveUiScale(next);
        }}
      >
        {UI_SCALES.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
            {o.value === 'auto' ? ` (${Math.round(effectiveUiScale('auto') * 100)}%)` : ''}
          </option>
        ))}
      </select>
      <div className="hint">For this device only. Automatic is larger in the Android app and follows your phone’s font size.</div>
    </div>
  );
}

/** Settings → General → Your name: shown at the bottom left (and to administrators). */
function YourName() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity });
  const [value, setValue] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const current = value ?? me.data?.displayName ?? '';
  const save = async () => {
    if (value === null || value === (me.data?.displayName ?? '')) return;
    try {
      const { name } = await api.saveName(value);
      setValue(name);
      setStatus('Saved');
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setStatus((err as Error).message);
    }
  };
  return (
    <div>
      <label className="label" htmlFor="your-name">
        Your name
      </label>
      <input
        id="your-name"
        className="input"
        style={{ maxWidth: 340 }}
        value={current}
        maxLength={100}
        placeholder="First name, or first and last"
        onChange={(e) => {
          setValue(e.target.value);
          setStatus(null);
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => e.key === 'Enter' && void save()}
      />
      <div className="hint">{status ?? 'Shown at the bottom left. Typed in lower case, it is capitalized for you.'}</div>
    </div>
  );
}

/** Settings → General: first name only (default) or the full name at the bottom left. */
function FullNameToggle({ v, save }: { v: Preferences; save: (p: Preferences) => Promise<void> }) {
  const shows = v.footerIdentity ?? 'both';
  return (
    <div>
      <label className="label">Bottom left shows</label>
      <div className="segmented">
        {(
          [
            ['both', 'Photo and name'],
            ['name', 'Name only'],
            ['photo', 'Photo only'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={shows === key ? 'on' : ''} onClick={() => void save({ ...v, footerIdentity: key })} style={{ padding: '6px 12px' }}>
            {label}
          </button>
        ))}
      </div>
      {shows !== 'photo' && (
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={v.showFullName} onChange={(e) => void save({ ...v, showFullName: e.target.checked })} />
          Show my full name (otherwise only the first name)
        </label>
      )}
    </div>
  );
}

/** Settings → General → Blocked senders: whose mail goes to Junk, per mailbox. */
function BlockedSenders({ accounts }: { accounts: { id: string; name: string; color: string }[] }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['blocked'], queryFn: api.blocked });
  const [accountId, setAccountId] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const acc = accountId || accounts[0]?.id || '';
  return (
    <div>
      <label className="label">Blocked senders</label>
      <div className="hint">Mail from these senders goes to Junk as it arrives. Block from a message (Block sender) or add one here; @domain.com blocks a whole domain.</div>
      {list.data && list.data.length > 0 && (
        <ul className="blocked-list">
          {list.data.map((b) => {
            const a = accounts.find((x) => x.id === b.accountId);
            return (
              <li key={`${b.accountId}:${b.address}`}>
                <span className="dot" style={{ background: a?.color ?? 'var(--muted)' }} />
                <span className="grow">
                  {b.address} <span className="muted">· {a?.name ?? 'Mailbox'}</span>
                </span>
                <button className="btn ghost" onClick={() => void api.unblock(b.accountId, b.address).then((l) => qc.setQueryData(['blocked'], l), (e: Error) => setError(e.message))}>
                  Unblock
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {accounts.length > 0 && (
        <form
          className="row-buttons"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            void api.block(acc, address).then(
              () => {
                setAddress('');
                void qc.invalidateQueries({ queryKey: ['blocked'] });
                void qc.invalidateQueries({ queryKey: ['messages'] });
              },
              (err: Error) => setError(err.message),
            );
          }}
        >
          <input className="input grow" value={address} placeholder="sender@example.com or @example.com" onChange={(e) => setAddress(e.target.value)} />
          {accounts.length > 1 && (
            <select className="input" style={{ width: 'auto' }} value={acc} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn" disabled={!address.trim()}>
            Block
          </button>
        </form>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/** Which client this is, for "This device". */
function deviceName(): string {
  const desktop = desktopBridge();
  if (desktop) return desktop.installKind === 'windows' ? 'Windows app' : `Linux app${desktop.installKind !== 'unknown' ? ` (${desktop.installKind})` : ''}`;
  if (androidBridge()) return 'Android app';
  return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches ? 'Installed web app' : 'Web browser';
}

/**
 * Settings → This device: everything that belongs to this device rather than to the account (app
 * version and updates, server address, interface size, this device's notifications, email links).
 * All other tabs are the account's and apply everywhere.
 */
/** In a browser: the desktop, Android or web app for this device. */
function InstallApp() {
  const version = useQuery({ queryKey: ['version'], queryFn: api.version, staleTime: 3600_000 });
  const [open, setOpen] = useState(false);
  if (runningAsApp() || !version.data) return null;
  return (
    <div>
      <label className="label">Install the app</label>
      <div className="hint">DreyMail as an app on this device: its own window, notifications in the background, and email links that open in it.</div>
      <button className="btn" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => setOpen(true)}>
        Install DreyMail…
      </button>
      {open && <InstallDialog version={version.data.version} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ThisDevice({ prefs, save }: { prefs: Preferences; save: (p: Preferences) => Promise<void> }) {
  const desktop = desktopBridge();
  const android = androidBridge();
  return (
    <>
      <div className="device-card">
        <strong>{deviceName()}</strong>
        <span className="muted">These settings are stored on this device only. Every other tab belongs to your account and applies on all your devices.</span>
      </div>
      <DesktopApp />
      <InstallApp />
      <DeviceSessionSettings />
      <InterfaceSize />
      <div>
        {(desktop || android) && <label className="label">Notifications on this device</label>}
        {desktop ? (
          <>
            <div className="hint">
              On, for every mailbox, whether the window is in front or not. Each notification shows the mailbox’s name and its icon in its
              color, and keeps coming while DreyMail runs in the tray.
            </div>
            <DesktopTestNotifications />
            <TrayOption />
          </>
        ) : android ? (
          <>
            <AndroidNotifications />
            <NotificationContentSelect prefs={prefs} save={save} />
            <div className="hint">Applies on all your devices. Your phone may still hide what a notification says while it’s locked; that’s in Android’s lock screen settings.</div>
          </>
        ) : (
          <Notifications prefs={prefs} save={save} />
        )}
      </div>
      {!desktop && !android && <EmailLinks />}
    </>
  );
}

