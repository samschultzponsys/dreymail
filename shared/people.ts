// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Contacts and tasks (DreyMail 10.4): DreyMail's own, next to Outlook (contacts, Microsoft To Do)
// and Google (Contacts, Google Tasks) of mailboxes whose owner allowed it.

export type PeopleSource = 'local' | 'microsoft' | 'google';

export interface Contact {
  /** "local:<id>", or "<source>~<accountId>~<provider id, base64url>". */
  id: string;
  source: PeopleSource;
  /** The mailbox it comes from (null for DreyMail's own). */
  accountId: string | null;
  name: string;
  emails: string[];
  phones: string[];
  company: string;
  title: string;
  notes: string;
}

export type ContactInput = Omit<Contact, 'id' | 'source' | 'accountId'> & { source?: PeopleSource; accountId?: string | null };

export interface TaskList {
  id: string;
  source: PeopleSource;
  accountId: string | null;
  name: string;
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  notes: string;
  /** Due day (YYYY-MM-DD), or null. */
  due: string | null;
  done: boolean;
}

export type TaskInput = Pick<Task, 'title' | 'notes' | 'due' | 'done'>;

/** Where contacts and tasks come from, and whether the user allowed each mailbox (Settings). */
export interface PeopleSourceView {
  accountId: string;
  kind: 'microsoft' | 'google';
  name: string;
  contacts: boolean;
  tasks: boolean;
}
