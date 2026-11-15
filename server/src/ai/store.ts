// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Storage for the AI mailbox assistant (tables made by the migration in db.ts): AI connections
// with their sealed keys, each mailbox's settings and rules, the history of what was done, and
// requests per connection per day.

import crypto from 'node:crypto';
import { presetFor, type AiApi, type AiConnectionView } from '../../../shared/aiProviders.js';
import type { AssistantDecision, AssistantRule, HistoryEntry, MailboxAssistantSettings, RuleAction, RuleConditions, RuleInput } from '../../../shared/assistant.js';
import type { Store } from '../db.js';

export interface ConnectionInput {
  name: string;
  preset: string;
  baseUrl: string;
  model: string;
  /** '' keeps the stored key. */
  apiKey: string;
  clearKey?: boolean;
  dailyLimit: number;
}

export interface StoredConnection {
  id: string;
  userId: string | null;
  name: string;
  preset: string;
  api: AiApi;
  baseUrl: string;
  model: string;
  apiKey: string;
  dailyLimit: number;
}

/** What undoing a history entry does: move messages back, or set flags back. */
export type UndoStep =
  | { type: 'move'; from: string; uidValidity: string; uids: number[]; to: string }
  | { type: 'flag'; folder: string; uidValidity: string; uids: number[]; flag: 'seen' | 'flagged'; value: boolean }
  | { type: 'label'; folder: string; uidValidity: string; uids: number[]; label: string; gmail: boolean };

const today = () => new Date().toISOString().slice(0, 10);
const json = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export class AssistantStore {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  private keyContext(id: string) {
    return `ai-connection:${id}`;
  }

  // ---- access -----------------------------------------------------------------

  /** '' = as the role says, 'on' / 'off' = set for this user by an administrator. */
  access(userId: string): '' | 'on' | 'off' {
    const r = this.db.prepare('SELECT ai_access FROM users WHERE id = ?').get(userId) as { ai_access: string } | undefined;
    return r?.ai_access === 'on' || r?.ai_access === 'off' ? r.ai_access : '';
  }

  setAccess(userId: string, value: '' | 'on' | 'off') {
    this.db.prepare('UPDATE users SET ai_access = ? WHERE id = ?').run(value, userId);
  }

  acceptedTerms(userId: string): boolean {
    const r = this.db.prepare('SELECT ai_terms_at FROM users WHERE id = ?').get(userId) as { ai_terms_at: number } | undefined;
    return !!r?.ai_terms_at;
  }

  acceptTerms(userId: string) {
    this.db.prepare('UPDATE users SET ai_terms_at = ? WHERE id = ?').run(Date.now(), userId);
  }

  // ---- connections --------------------------------------------------------------

  private rowToConnection(r: Record<string, unknown>): StoredConnection {
    let apiKey = '';
    try {
      apiKey = r.api_key ? this.store.openSecret(this.keyContext(String(r.id)), String(r.api_key)) : '';
    } catch {
      /* unreadable: treat as missing */
    }
    return {
      id: String(r.id),
      userId: (r.user_id as string | null) ?? null,
      name: String(r.name),
      preset: String(r.preset),
      api: r.api as AiApi,
      baseUrl: String(r.base_url),
      model: String(r.model),
      apiKey,
      dailyLimit: Number(r.daily_limit),
    };
  }

  /** A connection the user may use: their own, or a shared one (if `shared` allowed). */
  connection(userId: string, id: string, allowShared: boolean): StoredConnection | null {
    const r = this.db.prepare('SELECT * FROM ai_connections WHERE id = ? AND (user_id = ? OR (user_id IS NULL AND ?))').get(id, userId, allowShared ? 1 : 0) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToConnection(r) : null;
  }

  listConnections(userId: string, allowShared: boolean): AiConnectionView[] {
    const rows = this.db
      .prepare('SELECT * FROM ai_connections WHERE user_id = ? OR (user_id IS NULL AND ?) ORDER BY user_id IS NULL, created_at')
      .all(userId, allowShared ? 1 : 0) as Record<string, unknown>[];
    const links = this.db.prepare('SELECT account_id, connection_id FROM ai_mailboxes WHERE user_id = ?').all(userId) as { account_id: string; connection_id: string | null }[];
    const day = today();
    return rows.map((r) => {
      const c = this.rowToConnection(r);
      const used = this.db.prepare('SELECT requests FROM ai_usage WHERE connection_id = ? AND day = ?').get(c.id, day) as { requests: number } | undefined;
      return {
        id: c.id,
        name: c.name,
        preset: c.preset,
        api: c.api,
        baseUrl: c.baseUrl,
        model: c.model,
        hasKey: !!c.apiKey,
        dailyLimit: c.dailyLimit,
        shared: c.userId === null,
        accountIds: links.filter((l) => l.connection_id === c.id).map((l) => l.account_id),
        usedToday: used?.requests ?? 0,
      };
    });
  }

  /** Creates (id null) or changes a connection; `owner` null = shared. Null if not found. */
  saveConnection(owner: string | null, id: string | null, input: ConnectionInput): string | null {
    const preset = presetFor(input.preset) ?? presetFor('custom')!;
    const existing = id ? (this.db.prepare('SELECT * FROM ai_connections WHERE id = ? AND user_id IS ?').get(id, owner) as Record<string, unknown> | undefined) : undefined;
    if (id && !existing) return null;
    const connId = id ?? crypto.randomUUID();
    const oldKey = existing ? this.rowToConnection(existing).apiKey : '';
    const key = input.clearKey ? '' : input.apiKey.trim() || oldKey;
    const sealed = key ? this.store.sealSecret(this.keyContext(connId), key) : '';
    if (existing) {
      this.db
        .prepare('UPDATE ai_connections SET name = ?, preset = ?, api = ?, base_url = ?, model = ?, api_key = ?, daily_limit = ? WHERE id = ?')
        .run(input.name, preset.id, preset.api, input.baseUrl, input.model, sealed, input.dailyLimit, connId);
    } else {
      this.db
        .prepare('INSERT INTO ai_connections (id, user_id, name, preset, api, base_url, model, api_key, daily_limit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(connId, owner, input.name, preset.id, preset.api, input.baseUrl, input.model, sealed, input.dailyLimit, Date.now());
    }
    return connId;
  }

  deleteConnection(owner: string | null, id: string): boolean {
    return this.db.prepare('DELETE FROM ai_connections WHERE id = ? AND user_id IS ?').run(id, owner).changes > 0;
  }

  /** Counts one request (and its tokens) against today's limit. */
  recordUsage(connectionId: string, inputTokens: number, outputTokens: number) {
    this.db
      .prepare(
        `INSERT INTO ai_usage (connection_id, day, requests, input_tokens, output_tokens) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (connection_id, day) DO UPDATE SET requests = requests + 1, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(connectionId, today(), inputTokens, outputTokens);
  }

  usedToday(connectionId: string): number {
    const r = this.db.prepare('SELECT requests FROM ai_usage WHERE connection_id = ? AND day = ?').get(connectionId, today()) as { requests: number } | undefined;
    return r?.requests ?? 0;
  }

  // ---- mailboxes ---------------------------------------------------------------------

  mailbox(userId: string, accountId: string): MailboxAssistantSettings {
    const r = this.db.prepare('SELECT * FROM ai_mailboxes WHERE account_id = ? AND user_id = ?').get(accountId, userId) as
      | { enabled: number; connection_id: string | null; accuracy: number }
      | undefined;
    return { accountId, enabled: r?.enabled === 1, connectionId: r?.connection_id ?? null, accuracy: r?.accuracy ?? 4 };
  }

  saveMailbox(userId: string, s: MailboxAssistantSettings) {
    this.db
      .prepare(
        `INSERT INTO ai_mailboxes (account_id, user_id, connection_id, enabled, accuracy) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET connection_id = excluded.connection_id, enabled = excluded.enabled, accuracy = excluded.accuracy`,
      )
      .run(s.accountId, userId, s.connectionId, s.enabled ? 1 : 0, Math.min(4, Math.max(1, Math.round(s.accuracy))));
  }

  /** Points these mailboxes at a connection (others that used it keep it unless listed in `release`). */
  assignConnection(userId: string, connectionId: string | null, accountIds: string[], release: string[]) {
    for (const accountId of release) {
      this.db.prepare('UPDATE ai_mailboxes SET connection_id = NULL WHERE account_id = ? AND user_id = ? AND connection_id = ?').run(accountId, userId, connectionId);
    }
    for (const accountId of accountIds) this.saveMailbox(userId, { ...this.mailbox(userId, accountId), connectionId });
  }

  /** Every (user, mailbox) with the assistant switched on. */
  enabledMailboxes(): { userId: string; accountId: string }[] {
    return (this.db.prepare('SELECT user_id, account_id FROM ai_mailboxes WHERE enabled = 1').all() as { user_id: string; account_id: string }[]).map((r) => ({
      userId: r.user_id,
      accountId: r.account_id,
    }));
  }

  // ---- rules ---------------------------------------------------------------------------

  listRules(userId: string, accountId: string): AssistantRule[] {
    const rows = this.db.prepare('SELECT * FROM ai_rules WHERE user_id = ? AND account_id = ? ORDER BY position, created_at').all(userId, accountId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      instructions: String(r.instructions),
      conditions: json<RuleConditions>(String(r.conditions), {}),
      actions: json<RuleAction[]>(String(r.actions), []),
      enabled: r.enabled === 1,
    }));
  }

  saveRule(userId: string, accountId: string, id: string | null, input: RuleInput): string | null {
    if (id) {
      const n = this.db
        .prepare('UPDATE ai_rules SET name = ?, instructions = ?, conditions = ?, actions = ?, enabled = ? WHERE id = ? AND user_id = ? AND account_id = ?')
        .run(input.name, input.instructions, JSON.stringify(input.conditions), JSON.stringify(input.actions), input.enabled ? 1 : 0, id, userId, accountId).changes;
      return n ? id : null;
    }
    const ruleId = crypto.randomUUID();
    const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM ai_rules WHERE account_id = ?').get(accountId) as { p: number }).p;
    this.db
      .prepare('INSERT INTO ai_rules (id, user_id, account_id, name, instructions, conditions, actions, enabled, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ruleId, userId, accountId, input.name, input.instructions, JSON.stringify(input.conditions), JSON.stringify(input.actions), input.enabled ? 1 : 0, pos, Date.now());
    return ruleId;
  }

  deleteRule(userId: string, accountId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM ai_rules WHERE id = ? AND user_id = ? AND account_id = ?').run(id, userId, accountId).changes > 0;
  }

  /** New order of a mailbox's rules (ids not listed keep their place after the listed ones). */
  reorderRules(userId: string, accountId: string, ids: string[]) {
    ids.forEach((id, i) => this.db.prepare('UPDATE ai_rules SET position = ? WHERE id = ? AND user_id = ? AND account_id = ?').run(i, id, userId, accountId));
  }

  // ---- history ---------------------------------------------------------------------

  addHistory(userId: string, accountId: string, source: HistoryEntry['source'], decision: AssistantDecision, undo: UndoStep[]): number {
    const r = this.db
      .prepare('INSERT INTO ai_history (user_id, account_id, at, source, decision, undo) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, accountId, Date.now(), source, JSON.stringify(decision), JSON.stringify(undo));
    // Keep the newest 2,000 entries per mailbox.
    this.db
      .prepare('DELETE FROM ai_history WHERE account_id = ? AND id NOT IN (SELECT id FROM ai_history WHERE account_id = ? ORDER BY id DESC LIMIT 2000)')
      .run(accountId, accountId);
    return Number(r.lastInsertRowid);
  }

  listHistory(userId: string, accountId: string, limit = 200): HistoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM ai_history WHERE user_id = ? AND account_id = ? ORDER BY id DESC LIMIT ?').all(userId, accountId, limit) as Record<string, unknown>[];
    return rows.map((r) => {
      const undo = json<UndoStep[]>(String(r.undo), []);
      return {
        ...json<AssistantDecision>(String(r.decision), {} as AssistantDecision),
        id: Number(r.id),
        at: new Date(Number(r.at)).toISOString(),
        source: r.source as HistoryEntry['source'],
        undoable: undo.length > 0 && r.undone !== 1,
        undone: r.undone === 1,
      };
    });
  }

  historyUndo(userId: string, accountId: string, id: number): UndoStep[] | null {
    const r = this.db.prepare('SELECT undo, undone FROM ai_history WHERE id = ? AND user_id = ? AND account_id = ?').get(id, userId, accountId) as
      | { undo: string; undone: number }
      | undefined;
    if (!r || r.undone === 1) return null;
    return json<UndoStep[]>(r.undo, []);
  }

  markUndone(id: number) {
    this.db.prepare('UPDATE ai_history SET undone = 1 WHERE id = ?').run(id);
  }
}
