// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The search at the top of the folder bar (DreyMail 12.1): besides all mail, it can look in
// contacts, tasks, the calendar and settings. These are the matching rules (no DOM, tested).

import type { CalendarEvent } from '../../shared/calendar';
import type { Contact, Task, TaskList } from '../../shared/people';

export type SearchSource = 'contacts' | 'tasks' | 'calendar' | 'settings';
export const SEARCH_SOURCES: SearchSource[] = ['contacts', 'tasks', 'calendar', 'settings'];

const SOURCES_KEY = 'dreymail.globalSearchSources';

/** Which other places the search also looks in (this device; mail always). */
export function savedSources(): SearchSource[] {
  try {
    const v = JSON.parse(localStorage.getItem(SOURCES_KEY) ?? '["contacts"]') as unknown;
    return Array.isArray(v) ? SEARCH_SOURCES.filter((s) => v.includes(s)) : ['contacts'];
  } catch {
    return ['contacts'];
  }
}

export function saveSources(v: SearchSource[]) {
  try {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

/** Every word of the query appears somewhere in the texts (case and accents ignored). */
export function matches(query: string, texts: (string | null | undefined)[]): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const hay = fold(texts.filter(Boolean).join(' \u0000 '));
  const words = fold(query).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

export function matchContacts(q: string, contacts: Contact[], limit = 5): Contact[] {
  return contacts.filter((c) => matches(q, [c.name, c.company, ...c.emails, ...c.phones])).slice(0, limit);
}

export function matchTasks(q: string, tasks: (Task & { listName?: string })[], limit = 5): (Task & { listName?: string })[] {
  // Open tasks first.
  return tasks
    .filter((t) => matches(q, [t.title, t.notes]))
    .sort((a, b) => Number(a.done) - Number(b.done))
    .slice(0, limit);
}

/** Events whose title, place or notes match: the next ones first, then the latest past ones. */
export function matchEvents(q: string, events: CalendarEvent[], now = Date.now(), limit = 5): CalendarEvent[] {
  const hits = events.filter((e) => matches(q, [e.title, e.location, e.notes]));
  const upcoming = hits.filter((e) => Date.parse(e.end) >= now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const past = hits.filter((e) => Date.parse(e.end) < now).sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  return [...upcoming, ...past].slice(0, limit);
}

export interface SettingEntry {
  label: string;
  tab: string;
  /** Other words people may type for it. */
  words: string;
}

/** Where each setting lives (Settings tabs), with the words people use for it. */
export const SETTINGS_INDEX: SettingEntry[] = [
  { label: 'This device', tab: 'device', words: 'device phone computer' },
  { label: 'Interface size', tab: 'device', words: 'zoom font text size scale bigger smaller' },
  { label: 'Notifications on this device', tab: 'device', words: 'push alerts sound vibration notify' },
  { label: 'Notification icons (Android)', tab: 'device', words: 'android icon left right conversation group' },
  { label: 'Install the app', tab: 'device', words: 'pwa install desktop android apk' },
  { label: 'Signing in on this device', tab: 'device', words: 'lock idle stay signed in session passkey unlock' },
  { label: 'Email links', tab: 'device', words: 'mailto default handler' },
  { label: 'Window and tray', tab: 'device', words: 'tray minimize window desktop' },
  { label: 'Profile', tab: 'profile', words: 'name picture avatar photo gravatar' },
  { label: 'Appearance', tab: 'general', words: 'theme dark light accent color colour look' },
  { label: 'Screen transitions', tab: 'general', words: 'animation slide squirrel transition' },
  { label: 'Messages per page', tab: 'general', words: 'page size list' },
  { label: 'Sidebar shows', tab: 'general', words: 'folder bar calendar saved searches scheduled' },
  { label: 'Bottom left shows', tab: 'general', words: 'footer name version' },
  { label: 'Buttons pinned to each message', tab: 'general', words: 'toolbar reply buttons' },
  { label: 'Send delay (undo send)', tab: 'general', words: 'undo send delay cancel' },
  { label: 'All inboxes', tab: 'general', words: 'unified inbox combined' },
  { label: 'Conversations', tab: 'general', words: 'threads threaded grouping' },
  { label: 'Inbox tabs', tab: 'general', words: 'categories personal updates newsletters' },
  { label: 'Suggest addresses from', tab: 'general', words: 'autocomplete address book directory contacts' },
  { label: 'Cc and Bcc lines', tab: 'general', words: 'cc bcc compose' },
  { label: 'Signed and encrypted mail (S/MIME)', tab: 'general', words: 'smime certificate encrypt sign p12' },
  { label: 'Blocked senders', tab: 'general', words: 'block spam sender' },
  { label: 'Signatures', tab: 'signatures', words: 'signature sign-off' },
  { label: 'Auto-replies', tab: 'autoreplies', words: 'out of office vacation away automatic reply' },
  { label: 'Images', tab: 'privacy', words: 'remote images tracking pictures load privacy' },
  { label: 'Password', tab: 'password', words: 'change password' },
  { label: 'Search and storage', tab: 'cache', words: 'cache space storage index search split mailbox share' },
  { label: 'Backup', tab: 'backup', words: 'backup restore export import device settings schedule' },
  { label: 'AI connections', tab: 'ai', words: 'ai assistant openai claude model' },
  { label: 'Users', tab: 'users', words: 'users accounts people admin' },
  { label: 'Storage', tab: 'storage', words: 'storage space cache disk' },
  { label: 'Roles', tab: 'roles', words: 'roles permissions' },
  { label: 'Sign-in', tab: 'signin', words: 'oidc sso login registration passwords' },
  { label: 'Server', tab: 'server', words: 'server defaults cache limits push backups days meeting rooms' },
  { label: 'Outlook sign-in', tab: 'outlook', words: 'microsoft outlook office 365 azure' },
  { label: 'Google sign-in', tab: 'google', words: 'google gmail workspace' },
  { label: 'Android notifications', tab: 'android', words: 'android firebase fcm' },
];

export function matchSettings(q: string, tabs: string[] | null, limit = 5): SettingEntry[] {
  return SETTINGS_INDEX.filter((s) => (!tabs || tabs.includes(s.tab)) && matches(q, [s.label, s.words])).slice(0, limit);
}

export type { TaskList };
