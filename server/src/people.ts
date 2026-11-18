// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Contacts and tasks (DreyMail 10.4): DreyMail's own (in its database) next to Outlook contacts and
// Microsoft To Do (Microsoft Graph) and Google Contacts and Google Tasks, for mailboxes whose owner
// allowed it. Providers stay the source of truth: read live (cached briefly), written straight back.

import crypto from 'node:crypto';
import type { Contact, ContactInput, PeopleSource, PeopleSourceView, Task, TaskInput, TaskList } from '../../shared/people.js';
import type { Store } from './db.js';
import type { GoogleAuth } from './oauth/google.js';
import type { MicrosoftAuth } from './oauth/microsoft.js';

export type PeopleFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class PeopleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PEOPLE_API = 'https://people.googleapis.com/v1';
const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
const CACHE_MS = 2 * 60_000;

const json = <T>(v: unknown, fallback: T): T => {
  try {
    return (JSON.parse(String(v)) as T) ?? fallback;
  } catch {
    return fallback;
  }
};
const remoteId = (source: PeopleSource, accountId: string, id: string) => `${source}~${accountId}~${Buffer.from(id).toString('base64url')}`;
function parseId(id: string): { source: PeopleSource; accountId: string | null; remote: string } {
  if (id.startsWith('local:')) return { source: 'local', accountId: null, remote: id.slice(6) };
  const [source, accountId, enc] = id.split('~');
  if ((source !== 'microsoft' && source !== 'google') || !accountId || !enc) throw new PeopleError('Not found', 404);
  return { source, accountId, remote: Buffer.from(enc, 'base64url').toString() };
}
const clean = (list: string[]) => [...new Set(list.map((x) => x.trim()).filter(Boolean))].slice(0, 20);

export class People {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly deps: {
      store: Store;
      microsoft: Pick<MicrosoftAuth, 'accessToken'>;
      google: Pick<GoogleAuth, 'accessToken' | 'allowed'>;
      fetch?: PeopleFetch;
    },
  ) {}

  private get db() {
    return this.deps.store.db;
  }

  // ---- talking to providers -----------------------------------------------------------------------

  private async call<T>(token: string, method: string, url: string, body?: unknown): Promise<T> {
    const f = this.deps.fetch ?? (fetch as unknown as PeopleFetch);
    const res = await f(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const msg = /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      throw new PeopleError(msg ? `The provider said: ${msg}` : `The provider answered ${res.status}`, res.status >= 400 && res.status < 500 ? res.status : 502);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  private mailbox(userId: string, accountId: string) {
    const a = this.deps.store.listAccounts(userId).find((x) => x.id === accountId);
    if (!a || (a.auth !== 'microsoft' && a.auth !== 'google')) throw new PeopleError('Mailbox not found', 404);
    return a as typeof a & { auth: 'microsoft' | 'google' };
  }

  /** A token for this kind of data, or null when the user hasn't allowed it for the mailbox. */
  private async token(userId: string, accountId: string, what: 'contacts' | 'tasks'): Promise<string | null> {
    const a = this.mailbox(userId, accountId);
    try {
      if (a.auth === 'microsoft') return await this.deps.microsoft.accessToken(userId, a.id, what);
      return (await this.deps.google.allowed(userId, a.id, what)) ? await this.deps.google.accessToken(userId, a.id) : null;
    } catch {
      return null;
    }
  }
  private async need(userId: string, accountId: string, what: 'contacts' | 'tasks') {
    const t = await this.token(userId, accountId, what);
    if (!t) throw new PeopleError(`Allow ${what} for this mailbox first (Settings → General)`, 403);
    return t;
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value as T);
    return load().then((value) => {
      if (this.cache.size > 300) this.cache.clear();
      this.cache.set(key, { at: Date.now(), value });
      return value;
    });
  }
  private forget(prefix: string) {
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  /** Mailboxes that can bring contacts and tasks, and whether each is allowed. */
  async sources(userId: string): Promise<PeopleSourceView[]> {
    const list = this.deps.store.listAccounts(userId).filter((a) => (a.auth === 'microsoft' || a.auth === 'google') && !a.sharedOf);
    return Promise.all(
      list.map(async (a) => ({
        accountId: a.id,
        kind: a.auth as 'microsoft' | 'google',
        name: a.name,
        contacts: !!(await this.token(userId, a.id, 'contacts')),
        tasks: !!(await this.token(userId, a.id, 'tasks')),
      })),
    );
  }

  // ---- contacts ----------------------------------------------------------------------------------

  async contacts(userId: string): Promise<{ contacts: Contact[]; errors: { accountId: string; message: string }[] }> {
    const own = (this.db.prepare('SELECT * FROM contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId) as Record<string, unknown>[]).map(
      (r): Contact => ({ id: `local:${r.id}`, source: 'local', accountId: null, name: String(r.name), emails: json(r.emails, []), phones: json(r.phones, []), company: String(r.company), title: String(r.title), notes: String(r.notes) }),
    );
    const errors: { accountId: string; message: string }[] = [];
    const remote = await Promise.all(
      this.deps.store
        .listAccounts(userId)
        .filter((a) => (a.auth === 'microsoft' || a.auth === 'google') && !a.sharedOf)
        .map(async (a) => {
          const token = await this.token(userId, a.id, 'contacts');
          if (!token) return [];
          try {
            return await this.cached(`c|${a.id}`, () => (a.auth === 'microsoft' ? this.outlookContacts(token, a.id) : this.googleContacts(token, a.id)));
          } catch (err) {
            errors.push({ accountId: a.id, message: (err as Error).message });
            return [];
          }
        }),
    );
    const all = [...own, ...remote.flat()].sort((x, y) => (x.name || x.emails[0] || '').localeCompare(y.name || y.emails[0] || '', undefined, { sensitivity: 'base' }));
    return { contacts: all, errors };
  }

  private async outlookContacts(token: string, accountId: string): Promise<Contact[]> {
    const out: Contact[] = [];
    let url: string | undefined = `${GRAPH}/me/contacts?$top=500&$select=id,displayName,emailAddresses,businessPhones,mobilePhone,homePhones,companyName,jobTitle,personalNotes`;
    for (let i = 0; url && i < 10; i++) {
      const r: { value?: Record<string, unknown>[]; '@odata.nextLink'?: string } = await this.call(token, 'GET', url);
      for (const c of r.value ?? [])
        out.push({
          id: remoteId('microsoft', accountId, String(c.id)),
          source: 'microsoft',
          accountId,
          name: String(c.displayName ?? ''),
          emails: ((c.emailAddresses as { address?: string }[] | undefined) ?? []).map((e) => e.address ?? '').filter(Boolean),
          phones: [String(c.mobilePhone ?? ''), ...((c.businessPhones as string[] | undefined) ?? []), ...((c.homePhones as string[] | undefined) ?? [])].filter(Boolean),
          company: String(c.companyName ?? ''),
          title: String(c.jobTitle ?? ''),
          notes: String(c.personalNotes ?? ''),
        });
      url = r['@odata.nextLink']?.startsWith(GRAPH) ? r['@odata.nextLink'] : undefined;
    }
    return out;
  }

  private async googleContacts(token: string, accountId: string): Promise<Contact[]> {
    const out: Contact[] = [];
    let page = '';
    for (let i = 0; i < 10; i++) {
      const r = await this.call<{ connections?: GooglePerson[]; nextPageToken?: string }>(
        token,
        'GET',
        `${PEOPLE_API}/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations,biographies&pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`,
      );
      for (const p of r.connections ?? []) out.push(fromGoogle(p, accountId));
      if (!r.nextPageToken) break;
      page = r.nextPageToken;
    }
    return out;
  }

  async saveContact(userId: string, id: string | null, input: ContactInput): Promise<Contact> {
    const c = { ...input, emails: clean(input.emails), phones: clean(input.phones) };
    const target = id ? parseId(id) : { source: input.source ?? 'local', accountId: input.accountId ?? null, remote: '' };
    if (target.source === 'local') {
      const own = id ? target.remote : crypto.randomUUID();
      if (id && !this.db.prepare('SELECT 1 FROM contacts WHERE id = ? AND user_id = ?').get(own, userId)) throw new PeopleError('Not found', 404);
      this.db
        .prepare('INSERT INTO contacts (id, user_id, name, emails, phones, company, title, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, emails = excluded.emails, phones = excluded.phones, company = excluded.company, title = excluded.title, notes = excluded.notes, updated_at = excluded.updated_at')
        .run(own, userId, c.name, JSON.stringify(c.emails), JSON.stringify(c.phones), c.company, c.title, c.notes, Date.now());
      return { id: `local:${own}`, source: 'local', accountId: null, ...c };
    }
    const accountId = target.accountId!;
    const token = await this.need(userId, accountId, 'contacts');
    this.forget(`c|${accountId}`);
    if (target.source === 'microsoft') {
      const [mobile, ...business] = c.phones;
      const body = { displayName: c.name, emailAddresses: c.emails.map((address) => ({ address, name: c.name })), mobilePhone: mobile ?? null, businessPhones: business, companyName: c.company, jobTitle: c.title, personalNotes: c.notes };
      const r = id ? await this.call<{ id: string }>(token, 'PATCH', `${GRAPH}/me/contacts/${encodeURIComponent(target.remote)}`, body) : await this.call<{ id: string }>(token, 'POST', `${GRAPH}/me/contacts`, body);
      return { id: remoteId('microsoft', accountId, r.id), source: 'microsoft', accountId, ...c };
    }
    const person = {
      names: [{ unstructuredName: c.name }],
      emailAddresses: c.emails.map((value) => ({ value })),
      phoneNumbers: c.phones.map((value) => ({ value })),
      organizations: c.company || c.title ? [{ name: c.company, title: c.title }] : [],
      biographies: c.notes ? [{ value: c.notes, contentType: 'TEXT_PLAIN' }] : [],
    };
    let saved: GooglePerson;
    if (id) {
      const cur = await this.call<GooglePerson>(token, 'GET', `${PEOPLE_API}/${target.remote}?personFields=metadata`);
      saved = await this.call<GooglePerson>(token, 'PATCH', `${PEOPLE_API}/${target.remote}:updateContact?updatePersonFields=names,emailAddresses,phoneNumbers,organizations,biographies`, { ...person, etag: cur.etag });
    } else saved = await this.call<GooglePerson>(token, 'POST', `${PEOPLE_API}/people:createContact`, person);
    return fromGoogle(saved, accountId);
  }

  async deleteContact(userId: string, id: string) {
    const t = parseId(id);
    if (t.source === 'local') {
      if (!this.db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(t.remote, userId).changes) throw new PeopleError('Not found', 404);
      return;
    }
    const token = await this.need(userId, t.accountId!, 'contacts');
    this.forget(`c|${t.accountId}`);
    if (t.source === 'microsoft') await this.call(token, 'DELETE', `${GRAPH}/me/contacts/${encodeURIComponent(t.remote)}`);
    else await this.call(token, 'DELETE', `${PEOPLE_API}/${t.remote}:deleteContact`);
  }

  /** DreyMail's own contacts matching `q`, for address suggestions. */
  suggest(userId: string, q: string, limit = 8): { name: string; address: string }[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const out: { name: string; address: string }[] = [];
    for (const r of this.db.prepare('SELECT name, emails FROM contacts WHERE user_id = ? AND (lower(name) LIKE ? OR lower(emails) LIKE ?) LIMIT 50').all(userId, `%${needle}%`, `%${needle}%`) as { name: string; emails: string }[])
      for (const e of json<string[]>(r.emails, [])) if (out.length < limit) out.push({ name: r.name, address: e.toLowerCase() });
    return out;
  }

  // ---- tasks ---------------------------------------------------------------------------------------

  async lists(userId: string): Promise<{ lists: TaskList[]; errors: { accountId: string; message: string }[] }> {
    if (!this.db.prepare('SELECT 1 FROM task_lists WHERE user_id = ? LIMIT 1').get(userId))
      this.db.prepare('INSERT INTO task_lists (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), userId, 'Tasks', Date.now());
    const own = (this.db.prepare('SELECT id, name FROM task_lists WHERE user_id = ? ORDER BY created_at').all(userId) as { id: string; name: string }[]).map((r): TaskList => ({ id: `local:${r.id}`, source: 'local', accountId: null, name: r.name }));
    const errors: { accountId: string; message: string }[] = [];
    const remote = await Promise.all(
      this.deps.store
        .listAccounts(userId)
        .filter((a) => (a.auth === 'microsoft' || a.auth === 'google') && !a.sharedOf)
        .map(async (a) => {
          const token = await this.token(userId, a.id, 'tasks');
          if (!token) return [];
          try {
            return await this.cached(`l|${a.id}`, async (): Promise<TaskList[]> => {
              if (a.auth === 'microsoft') {
                const r = await this.call<{ value?: { id: string; displayName: string }[] }>(token, 'GET', `${GRAPH}/me/todo/lists`);
                return (r.value ?? []).map((l) => ({ id: remoteId('microsoft', a.id, l.id), source: 'microsoft', accountId: a.id, name: l.displayName }));
              }
              const r = await this.call<{ items?: { id: string; title: string }[] }>(token, 'GET', `${TASKS_API}/users/@me/lists?maxResults=100`);
              return (r.items ?? []).map((l) => ({ id: remoteId('google', a.id, l.id), source: 'google', accountId: a.id, name: l.title }));
            });
          } catch (err) {
            errors.push({ accountId: a.id, message: (err as Error).message });
            return [];
          }
        }),
    );
    return { lists: [...own, ...remote.flat()], errors };
  }

  async tasks(userId: string, listId: string): Promise<Task[]> {
    const l = parseId(listId);
    if (l.source === 'local') {
      this.ownList(userId, l.remote);
      return (this.db.prepare('SELECT * FROM tasks WHERE list_id = ? ORDER BY done, due_day IS NULL, due_day, created_at').all(l.remote) as Record<string, unknown>[]).map((r) => ({
        id: `local:${r.id}`,
        listId,
        title: String(r.title),
        notes: String(r.notes),
        due: (r.due_day as string | null) ?? null,
        done: r.done === 1,
      }));
    }
    const token = await this.need(userId, l.accountId!, 'tasks');
    return this.cached(`t|${listId}`, async () => {
      if (l.source === 'microsoft') {
        const out: Task[] = [];
        let url: string | undefined = `${GRAPH}/me/todo/lists/${encodeURIComponent(l.remote)}/tasks?$top=200`;
        for (let i = 0; url && i < 10; i++) {
          const r: { value?: { id: string; title: string; body?: { content?: string }; dueDateTime?: { dateTime: string }; status?: string }[]; '@odata.nextLink'?: string } = await this.call(token, 'GET', url);
          for (const t of r.value ?? []) out.push({ id: remoteId('microsoft', l.accountId!, `${l.remote}\u0000${t.id}`), listId, title: t.title, notes: (t.body?.content ?? '').trim(), due: t.dueDateTime?.dateTime.slice(0, 10) ?? null, done: t.status === 'completed' });
          url = r['@odata.nextLink']?.startsWith(GRAPH) ? r['@odata.nextLink'] : undefined;
        }
        return sortTasks(out);
      }
      const r = await this.call<{ items?: { id: string; title?: string; notes?: string; due?: string; status?: string }[] }>(token, 'GET', `${TASKS_API}/lists/${encodeURIComponent(l.remote)}/tasks?showCompleted=true&showHidden=true&maxResults=100`);
      return sortTasks((r.items ?? []).filter((t) => t.title).map((t) => ({ id: remoteId('google', l.accountId!, `${l.remote}\u0000${t.id}`), listId, title: t.title ?? '', notes: t.notes ?? '', due: t.due?.slice(0, 10) ?? null, done: t.status === 'completed' })));
    });
  }

  private ownList(userId: string, id: string) {
    if (!this.db.prepare('SELECT 1 FROM task_lists WHERE id = ? AND user_id = ?').get(id, userId)) throw new PeopleError('List not found', 404);
  }

  async saveTask(userId: string, listId: string, id: string | null, input: TaskInput): Promise<Task> {
    const l = parseId(listId);
    const t = { title: input.title.trim().slice(0, 500) || '(no title)', notes: input.notes.slice(0, 10_000), due: input.due, done: input.done };
    if (l.source === 'local') {
      this.ownList(userId, l.remote);
      const own = id ? parseId(id).remote : crypto.randomUUID();
      if (id && !this.db.prepare('SELECT 1 FROM tasks WHERE id = ? AND list_id = ?').get(own, l.remote)) throw new PeopleError('Not found', 404);
      this.db
        .prepare('INSERT INTO tasks (id, list_id, title, notes, due_day, done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title, notes = excluded.notes, due_day = excluded.due_day, done = excluded.done, updated_at = excluded.updated_at')
        .run(own, l.remote, t.title, t.notes, t.due, t.done ? 1 : 0, Date.now(), Date.now());
      return { id: `local:${own}`, listId, ...t };
    }
    const token = await this.need(userId, l.accountId!, 'tasks');
    this.forget(`t|${listId}`);
    const taskId = id ? parseId(id).remote.split('\u0000')[1]! : null;
    if (l.source === 'microsoft') {
      const body = { title: t.title, body: { content: t.notes, contentType: 'text' }, status: t.done ? 'completed' : 'notStarted', dueDateTime: t.due ? { dateTime: `${t.due}T00:00:00`, timeZone: 'UTC' } : null };
      const base = `${GRAPH}/me/todo/lists/${encodeURIComponent(l.remote)}/tasks`;
      const r = taskId ? await this.call<{ id: string }>(token, 'PATCH', `${base}/${encodeURIComponent(taskId)}`, body) : await this.call<{ id: string }>(token, 'POST', base, body);
      return { id: remoteId('microsoft', l.accountId!, `${l.remote}\u0000${r.id}`), listId, ...t };
    }
    const body = { title: t.title, notes: t.notes, status: t.done ? 'completed' : 'needsAction', due: t.due ? `${t.due}T00:00:00.000Z` : null, ...(t.done ? {} : { completed: null }) };
    const base = `${TASKS_API}/lists/${encodeURIComponent(l.remote)}/tasks`;
    const r = taskId ? await this.call<{ id: string }>(token, 'PATCH', `${base}/${encodeURIComponent(taskId)}`, body) : await this.call<{ id: string }>(token, 'POST', base, body);
    return { id: remoteId('google', l.accountId!, `${l.remote}\u0000${r.id}`), listId, ...t };
  }

  async deleteTask(userId: string, listId: string, id: string) {
    const l = parseId(listId);
    if (l.source === 'local') {
      this.ownList(userId, l.remote);
      if (!this.db.prepare('DELETE FROM tasks WHERE id = ? AND list_id = ?').run(parseId(id).remote, l.remote).changes) throw new PeopleError('Not found', 404);
      return;
    }
    const token = await this.need(userId, l.accountId!, 'tasks');
    this.forget(`t|${listId}`);
    const taskId = parseId(id).remote.split('\u0000')[1]!;
    if (l.source === 'microsoft') await this.call(token, 'DELETE', `${GRAPH}/me/todo/lists/${encodeURIComponent(l.remote)}/tasks/${encodeURIComponent(taskId)}`);
    else await this.call(token, 'DELETE', `${TASKS_API}/lists/${encodeURIComponent(l.remote)}/tasks/${encodeURIComponent(taskId)}`);
  }

  /** A new DreyMail task list. */
  addList(userId: string, name: string): TaskList {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO task_lists (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, userId, name.trim().slice(0, 100) || 'Tasks', Date.now());
    return { id: `local:${id}`, source: 'local', accountId: null, name };
  }
}

interface GooglePerson {
  resourceName: string;
  etag?: string;
  names?: { displayName?: string; unstructuredName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  organizations?: { name?: string; title?: string }[];
  biographies?: { value?: string }[];
}

function fromGoogle(p: GooglePerson, accountId: string): Contact {
  return {
    id: remoteId('google', accountId, p.resourceName),
    source: 'google',
    accountId,
    name: p.names?.[0]?.displayName ?? p.names?.[0]?.unstructuredName ?? '',
    emails: (p.emailAddresses ?? []).map((e) => e.value ?? '').filter(Boolean),
    phones: (p.phoneNumbers ?? []).map((e) => e.value ?? '').filter(Boolean),
    company: p.organizations?.[0]?.name ?? '',
    title: p.organizations?.[0]?.title ?? '',
    notes: p.biographies?.[0]?.value ?? '',
  };
}

/** Open tasks first (soonest due first, undated last), then done ones. */
function sortTasks(list: Task[]): Task[] {
  return list.sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.title.localeCompare(b.title));
}
