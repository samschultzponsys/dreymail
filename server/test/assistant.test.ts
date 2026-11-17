// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AssistantRule } from '../../shared/assistant.js';
import { conditionsHold, systemPrompt, AssistantEngine } from '../src/ai/engine.js';
import { AiClient, extractJson, type FetchLike } from '../src/ai/providers.js';
import { AssistantStore } from '../src/ai/store.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

const secret = crypto.randomBytes(48).toString('base64');

/** A fake AI service: records requests, answers with `reply(body)`. */
function fakeFetch(reply: (url: string, body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const f: FetchLike = async (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body, headers: init.headers });
    const r = reply(url, body);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  };
  return { f, calls };
}

const rule = (over: Partial<AssistantRule>): AssistantRule => ({ id: 'r', name: 'Rule', instructions: '', conditions: {}, actions: [{ type: 'archive' }], enabled: true, ...over });
const msg = { from: 'News <news@shop.example>', to: 'sam@example.com', subject: 'Big sale this week', hasAttachment: false };

describe('AI providers', () => {
  it('reads JSON wrapped in prose or code fences', () => {
    expect(extractJson('Sure! ```json\n{"rule": 2, "reason": "x"}\n```')).toEqual({ rule: 2, reason: 'x' });
    expect(() => extractJson('no json here')).toThrow(/JSON/);
  });

  it('OpenAI-style servers: falls back from structured output to JSON mode, sends the key as Bearer', async () => {
    const { f, calls } = fakeFetch((_u, body) =>
      (body.response_format as { type: string } | undefined)?.type === 'json_schema'
        ? { status: 400, json: { error: { message: 'response_format json_schema not supported' } } }
        : { json: { choices: [{ message: { content: '{"ok": true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } } },
    );
    const client = new AiClient(f);
    const res = await client.askJson({ api: 'openai', baseUrl: 'http://lm.local:1234/v1/', model: 'qwen', apiKey: 'k' }, { system: 's', user: 'u', schema: z.object({ ok: z.boolean() }) });
    expect(res).toEqual({ data: { ok: true }, usage: { inputTokens: 10, outputTokens: 2 } });
    expect(calls.map((c) => (c.body.response_format as { type: string } | undefined)?.type)).toEqual(['json_schema', 'json_object']);
    expect(calls[0]!.url).toBe('http://lm.local:1234/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer k');
  });

  it('local servers without a key send no Authorization header', async () => {
    const { f, calls } = fakeFetch(() => ({ json: { choices: [{ message: { content: '{"ok": true}' } }] } }));
    await new AiClient(f).askJson({ api: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama', apiKey: '' }, { system: 's', user: 'u', schema: z.object({ ok: z.boolean() }) });
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('Gemini: key in a header, JSON response, usage counted', async () => {
    const { f, calls } = fakeFetch(() => ({ json: { candidates: [{ content: { parts: [{ text: '{"ok": true}' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } } }));
    const res = await new AiClient(f).askJson({ api: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'models/gemini-x', apiKey: 'g' }, { system: 's', user: 'u', schema: z.object({ ok: z.boolean() }) });
    expect(res.data).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('g');
  });

  it("an answer that doesn't fit the schema is an error, never a decision", async () => {
    const { f } = fakeFetch(() => ({ json: { choices: [{ message: { content: '{"rule": "delete everything"}' } }] } }));
    await expect(
      new AiClient(f).askJson({ api: 'openai', baseUrl: 'http://x/v1', model: 'm', apiKey: '' }, { system: 's', user: 'u', schema: z.object({ rule: z.number().nullable(), reason: z.string() }) }),
    ).rejects.toThrow(/expected shape/);
  });
});

describe('rules', () => {
  it('exact conditions: all that are set must hold (case-insensitive)', () => {
    expect(conditionsHold(rule({ conditions: { from: 'SHOP.example' } }), msg)).toBe(true);
    expect(conditionsHold(rule({ conditions: { from: 'shop', subject: 'invoice' } }), msg)).toBe(false);
    expect(conditionsHold(rule({ conditions: { hasAttachment: true } }), msg)).toBe(false);
  });

  it('the prompt numbers the rules in order and treats the email as data', () => {
    const p = systemPrompt([rule({ name: 'Newsletters', instructions: 'marketing mail' }), rule({ name: 'Bills', instructions: 'invoices' })]);
    expect(p).toContain('1. Newsletters: marketing mail');
    expect(p).toContain('2. Bills: invoices');
    expect(p).toMatch(/not instructions/);
  });

  it('a conditions-only rule decides without asking the AI; AI rules before it are asked in one request', async () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    const ai = new AssistantStore(store);
    const { f, calls } = fakeFetch(() => ({ json: { choices: [{ message: { content: '{"rule": null, "reason": "not marketing"}' } }] } }));
    const engine = new AssistantEngine({ store, ai, client: new AiClient(f), pool: {} as never, mail: {} as never, access: {} as never });
    const conn = { id: 'c', userId: 'u', name: 'Local', preset: 'ollama', api: 'openai' as const, baseUrl: 'http://x/v1', model: 'm', apiKey: '', dailyLimit: 0 };
    const view = { ...msg, uid: 1, uidValidity: '1', folder: 'INBOX', date: '', prompt: 'p' };
    const onlyStatic = await engine.decide(conn, [rule({ id: 'a', name: 'Shop', conditions: { from: 'shop' } })], view);
    expect(onlyStatic.rule?.id).toBe('a');
    expect(calls).toHaveLength(0);
    const mixed = await engine.decide(conn, [rule({ id: 'ai', name: 'Promo', instructions: 'marketing' }), rule({ id: 'b', name: 'Shop', conditions: { from: 'shop' } })], view);
    expect(calls).toHaveLength(1);
    expect(mixed.rule?.id).toBe('b');
  });

  it('stops at the daily limit', async () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    const ai = new AssistantStore(store);
    ai.recordUsage('c', 1, 1);
    const engine = new AssistantEngine({ store, ai, client: new AiClient(fakeFetch(() => ({ json: {} })).f), pool: {} as never, mail: {} as never, access: {} as never });
    const conn = { id: 'c', userId: 'u', name: 'Capped', preset: 'ollama', api: 'openai' as const, baseUrl: 'http://x/v1', model: 'm', apiKey: '', dailyLimit: 1 };
    await expect(engine.decide(conn, [rule({ instructions: 'x' })], { ...msg, uid: 1, uidValidity: '1', folder: 'INBOX', date: '', prompt: 'p' })).rejects.toThrow(/Daily limit/);
  });
});

describe('assistant API', () => {
  let ctx: App | null = null;
  afterEach(async () => {
    await ctx?.app.close();
    ctx = null;
  });

  it('is a permission: Superadmins have it, Users only when switched on; keys are never sent back', async () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_REGISTRATION: 'open' }), { store, logger: false });
    const register = async (username: string) => {
      const res = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username, password: 'a long password' }, headers: { 'x-dreymail': '1' } });
      return `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`;
    };
    const sam = await register('sam');
    const eve = await register('eve');
    const call = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => ctx!.app.inject({ method, url, payload, headers: { cookie, 'x-dreymail': '1' } });
    expect((await call(eve, 'GET', '/api/assistant/status')).json()).toMatchObject({ allowed: false });
    expect((await call(eve, 'GET', '/api/assistant/connections')).statusCode).toBe(403);
    expect((await call(sam, 'GET', '/api/assistant/status')).json()).toMatchObject({ allowed: true, acceptedTerms: false, canShare: true });
    const saved = await call(sam, 'POST', '/api/assistant/connections', { name: 'Claude', preset: 'anthropic', baseUrl: '', model: 'claude-haiku-5-5', apiKey: 'sk-secret', dailyLimit: 100 });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('sk-secret');
    expect(saved.json()[0]).toMatchObject({ name: 'Claude', baseUrl: 'https://api.anthropic.com', hasKey: true, shared: false });
    // A per-user switch turns it on for one user.
    new AssistantStore(store).setAccess(store.listUsers().find((u) => u.username === 'eve')!.id, 'on');
    expect((await call(eve, 'GET', '/api/assistant/status')).json()).toMatchObject({ allowed: true, canShare: false });
    // A non-admin can't point a connection at the local network or share one.
    const local = await call(eve, 'POST', '/api/assistant/connections', { name: 'LM', preset: 'lmstudio', baseUrl: 'http://192.168.1.20:1234/v1', model: 'x' });
    expect(local.statusCode).toBe(400);
    expect(local.json().error).toMatch(/administrator/);
    expect((await call(eve, 'POST', '/api/assistant/connections', { name: 'S', preset: 'anthropic', baseUrl: '', model: 'm', shared: true })).statusCode).toBe(403);
    // Eve sees Sam's private connection? No.
    expect((await call(eve, 'GET', '/api/assistant/connections')).json()).toEqual([]);
  });
});

describe('unsubscribe headers', () => {
  it('finds one-click, web and mail targets', async () => {
    const { parseUnsubscribe } = await import('../src/ai/engine.js');
    expect(parseUnsubscribe('<mailto:u@list.example?subject=unsub>, <https://list.example/u/123>', 'List-Unsubscribe=One-Click')).toEqual({
      oneClick: 'https://list.example/u/123',
      url: 'https://list.example/u/123',
      mailto: 'mailto:u@list.example?subject=unsub',
    });
    expect(parseUnsubscribe('<https://list.example/u/123>', '')).toMatchObject({ oneClick: null, url: 'https://list.example/u/123' });
    // Plain http is never followed.
    expect(parseUnsubscribe('<http://list.example/u>', 'List-Unsubscribe=One-Click')).toBeNull();
  });
});

describe('learning mode', () => {
  it('starts, extends up to 30 days in all, ends early, and asks for a review once', () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    const ai = new AssistantStore(store);
    const u = store.upsertUser('local', 'sam', '', 'Sam');
    const a = store.createAccount(u.id, {
      name: 'G', displayName: 'S', email: 's@x', color: '#22d3ee',
      imap: { host: 'h', port: 993, tls: 'tls', user: 'u', password: 'p' }, smtp: { host: 'h', port: 465, tls: 'tls', user: 'u', password: 'p' }, appendSent: true,
    });
    const day = 86_400_000;
    ai.startLearning(u.id, a.id, Date.now() + 14 * day, true);
    expect(ai.learning(u.id, a.id)).toMatchObject({ active: true, reviewDue: false });
    expect(ai.enabledMailboxes()).toEqual([{ userId: u.id, accountId: a.id }]);
    ai.observe(u.id, a.id, { kind: 'arrived', messageId: '<1@x>', sender: 'a@x', subject: 's' });
    expect(ai.learning(u.id, a.id).observations).toBe(1);
    ai.stopLearning(u.id, a.id);
    expect(ai.learning(u.id, a.id)).toMatchObject({ active: false, reviewDue: true });
    expect(ai.reviewsDue(u.id)).toEqual([a.id]);
    ai.setReviewAfter(u.id, a.id, Date.now() + day);
    expect(ai.reviewsDue(u.id)).toEqual([]);
    ai.setReviewAfter(u.id, a.id, 0);
    expect(ai.learning(u.id, a.id).reviewDue).toBe(false);
    // A fresh start forgets earlier observations.
    ai.startLearning(u.id, a.id, Date.now() + day, true);
    expect(ai.learning(u.id, a.id).observations).toBe(0);
  });
});

describe('sending and writing actions (9.8)', () => {
  const setup = (aiReply: string) => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
    const acc = store.createAccount(user.id, { name: 'Work', displayName: 'Sam', email: 'sam@example.com', color: '#22d3ee', imap: { host: 'imap.example.com', port: 993, tls: 'tls', user: 'sam', password: 'pw' }, smtp: { host: 'smtp.example.com', port: 465, tls: 'tls', user: 'sam', password: 'pw' }, appendSent: true } as never);
    const ai = new AssistantStore(store);
    const connId = ai.saveConnection(user.id, null, { name: 'Local', preset: 'ollama', baseUrl: 'http://x/v1', model: 'm', apiKey: '', dailyLimit: 0 })!;
    ai.saveMailbox(user.id, { ...ai.mailbox(user.id, acc.id), connectionId: connId, enabled: true });
    const { f, calls } = fakeFetch(() => ({ json: { choices: [{ message: { content: aiReply } }] } }));
    const done: string[] = [];
    const client = { fetchOne: async () => ({ uid: 5, envelope: { messageId: '<m1@shop.example>' }, headers: Buffer.from('List-Unsubscribe: <mailto:u@shop.example>\r\n') }) };
    const engine = new AssistantEngine({
      store,
      ai,
      client: new AiClient(f),
      pool: { withMailbox: async (_u: string, _a: string, _f: string, fn: (c: typeof client) => unknown) => fn(client) } as never,
      mail: { getParsed: async () => ({ from: { address: 'ada@shop.example', name: 'Ada' }, subject: 'Order 42', text: 'Where is my order?', attachments: [] }) } as never,
      access: {} as never,
      outgoing: {
        forward: async (_u, ref, to) => void done.push(`forward ${ref.uid} to ${to}`),
        draftReply: async (_u, ref, text) => void done.push(`draft for ${ref.uid}: ${text}`),
        category: async (_u, _a, id, name) => (done.push(`category ${name} on ${id}`), true),
      },
    });
    return { engine, user, acc, done, calls };
  };

  it('forwards, writes a reply draft with the AI, and puts on an Outlook category', async () => {
    const t = setup('{"reply": "Hi Ada,\\n\\nIt ships tomorrow.\\n\\nSam"}');
    await t.engine.apply(t.user.id, t.acc.id, { folder: 'INBOX', uidValidity: '1', uid: 5 }, [
      { type: 'forward', to: 'boss@example.com' },
      { type: 'draftReply', instructions: 'say it ships tomorrow' },
      { type: 'category', name: 'Orders' },
      { type: 'unsubscribe' },
    ]);
    expect(t.done).toEqual(['forward 5 to boss@example.com', 'draft for 5: Hi Ada,\n\nIt ships tomorrow.\n\nSam', 'category Orders on <m1@shop.example>']);
    // The AI got the message as data, and the owner's instructions.
    const sent = JSON.stringify(t.calls[0]!.body);
    expect(sent).toContain('Where is my order?');
    expect(sent).toContain('say it ships tomorrow');
  });
});
