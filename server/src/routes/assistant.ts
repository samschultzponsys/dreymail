// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The AI mailbox assistant's API: the "AI can make mistakes" notice, AI connections (with mailbox
// checkboxes), and per mailbox its settings, rules, preview, history and undo.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { presetFor } from '../../../shared/aiProviders.js';
import type { RuleInput } from '../../../shared/assistant.js';
import type { Access } from '../access.js';
import type { AssistantEngine } from '../ai/engine.js';
import { AiError, type AiClient, type AiTarget } from '../ai/providers.js';
import type { AssistantStore } from '../ai/store.js';
import type { Store } from '../db.js';
import { assertPublicHost } from '../net/ssrf.js';

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), folder: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal('label'), name: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal('archive') }),
  z.object({ type: z.literal('read') }),
  z.object({ type: z.literal('star') }),
  z.object({ type: z.literal('trash') }),
  z.object({ type: z.literal('spam') }),
]);
const ruleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  instructions: z.string().trim().max(2000),
  conditions: z
    .object({
      from: z.string().trim().max(200).optional(),
      to: z.string().trim().max(200).optional(),
      subject: z.string().trim().max(200).optional(),
      hasAttachment: z.boolean().optional(),
    })
    .default({}),
  actions: z.array(actionSchema).min(1).max(8),
  enabled: z.boolean().default(true),
});
const connectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  preset: z.string().max(40),
  baseUrl: z.string().trim().max(500),
  model: z.string().trim().max(200),
  apiKey: z.string().max(500).default(''),
  clearKey: z.boolean().default(false),
  dailyLimit: z.number().int().min(0).max(1_000_000).default(500),
  shared: z.boolean().default(false),
});

export function registerAssistantRoutes(
  app: FastifyInstance,
  deps: { store: Store; ai: AssistantStore; engine: AssistantEngine; client: AiClient; access: Access },
) {
  const { store, ai, engine, client, access } = deps;
  const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ error });

  /** The signed-in user, if they may use the assistant (else answers 403). */
  const allowed = (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user!;
    if (!engine.allowed(user)) {
      void bad(reply, "Your role doesn't include the AI assistant", 403);
      return null;
    }
    return user;
  };
  const canShare = (req: FastifyRequest) => access.can(req.user!, 'ai.manage');
  const ownsAccount = (userId: string, accountId: string) => store.listAccounts(userId).some((a) => a.id === accountId);

  /** A checked server address: https anywhere, or a private-network server for those allowed to use one. */
  const checkBaseUrl = async (req: FastifyRequest, raw: string): Promise<string> => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new AiError('The server address is not a valid URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AiError('The server address must start with https:// or http://');
    try {
      await assertPublicHost(url.hostname);
    } catch {
      if (!canShare(req)) throw new AiError('Servers on your own network (LM Studio, Ollama, …) can only be set up by an administrator, as a shared AI connection');
    }
    return url.toString().replace(/\/+$/, '');
  };

  // ---- status and notice ------------------------------------------------------------------

  app.get('/api/assistant/status', async (req) => ({
    allowed: engine.allowed(req.user!),
    acceptedTerms: ai.acceptedTerms(req.user!.id),
    canShare: canShare(req),
  }));

  app.post('/api/assistant/terms', async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    ai.acceptTerms(req.user!.id);
    return { ok: true };
  });

  // ---- AI connections ---------------------------------------------------------------------

  app.get('/api/assistant/connections', async (req, reply) => {
    const user = allowed(req, reply);
    return user ? ai.listConnections(user.id, true) : reply;
  });

  const saveConnection = async (req: FastifyRequest, reply: FastifyReply, id: string | null) => {
    const user = allowed(req, reply);
    if (!user) return reply;
    const body = connectionSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Check the name, service and model');
    if (body.data.shared && !canShare(req)) return bad(reply, 'Only administrators can share an AI connection', 403);
    const preset = presetFor(body.data.preset);
    if (!preset) return bad(reply, 'Unknown AI service');
    try {
      const baseUrl = await checkBaseUrl(req, body.data.baseUrl || preset.baseUrl);
      const owner = body.data.shared ? null : user.id;
      const saved = ai.saveConnection(owner, id, { ...body.data, baseUrl });
      if (!saved) return bad(reply, 'AI connection not found', 404);
      return ai.listConnections(user.id, true);
    } catch (err) {
      if (err instanceof AiError) return bad(reply, err.message);
      throw err;
    }
  };
  app.post('/api/assistant/connections', async (req, reply) => saveConnection(req, reply, null));
  app.put<{ Params: { id: string } }>('/api/assistant/connections/:id', async (req, reply) => saveConnection(req, reply, req.params.id));
  app.delete<{ Params: { id: string } }>('/api/assistant/connections/:id', async (req, reply) => {
    const user = allowed(req, reply);
    if (!user) return reply;
    const ok = ai.deleteConnection(user.id, req.params.id) || (canShare(req) && ai.deleteConnection(null, req.params.id));
    if (!ok) return bad(reply, 'AI connection not found', 404);
    engine.syncWatching();
    return ai.listConnections(user.id, true);
  });

  /** Which of the user's mailboxes use this connection (the checkboxes). */
  app.put<{ Params: { id: string } }>('/api/assistant/connections/:id/mailboxes', async (req, reply) => {
    const user = allowed(req, reply);
    if (!user) return reply;
    const body = z.object({ accountIds: z.array(z.string().max(64)).max(200) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    if (!ai.connection(user.id, req.params.id, true)) return bad(reply, 'AI connection not found', 404);
    const own = store.listAccounts(user.id).map((a) => a.id);
    const picked = body.data.accountIds.filter((id) => own.includes(id));
    ai.assignConnection(user.id, req.params.id, picked, own.filter((id) => !picked.includes(id)));
    engine.syncWatching(user.id);
    return ai.listConnections(user.id, true);
  });

  /** The target to talk to for "Load models" / "Test": the form's values, a stored key filling in a blank one. */
  const targetFrom = async (req: FastifyRequest, userId: string): Promise<AiTarget> => {
    const body = z.object({ id: z.string().max(64).optional(), preset: z.string().max(40), baseUrl: z.string().max(500), apiKey: z.string().max(500).default(''), model: z.string().max(200).default('') }).parse(req.body);
    const preset = presetFor(body.preset);
    if (!preset) throw new AiError('Unknown AI service');
    const stored = body.id ? ai.connection(userId, body.id, true) : null;
    return { api: preset.api, baseUrl: await checkBaseUrl(req, body.baseUrl || preset.baseUrl), apiKey: body.apiKey || stored?.apiKey || '', model: body.model };
  };

  app.post('/api/assistant/connections/models', async (req, reply) => {
    const user = allowed(req, reply);
    if (!user) return reply;
    try {
      return { models: await client.listModels(await targetFrom(req, user.id)) };
    } catch (err) {
      return bad(reply, (err as Error).message, err instanceof AiError ? 400 : 502);
    }
  });

  app.post('/api/assistant/connections/test', async (req, reply) => {
    const user = allowed(req, reply);
    if (!user) return reply;
    try {
      const t = await targetFrom(req, user.id);
      const { data } = await client.askJson(t, {
        system: 'Reply with the JSON object {"ok": true}.',
        user: 'Connection test',
        schema: z.object({ ok: z.boolean() }),
        maxTokens: 512,
      });
      return { ok: data.ok === true };
    } catch (err) {
      return bad(reply, (err as Error).message, err instanceof AiError ? 400 : 502);
    }
  });

  // ---- per mailbox ----------------------------------------------------------------------------

  type P = { Params: { accountId: string } };
  const mailbox = (req: FastifyRequest<P>, reply: FastifyReply) => {
    const user = allowed(req, reply);
    if (!user) return null;
    if (!ownsAccount(user.id, req.params.accountId)) {
      void bad(reply, 'Mailbox not found', 404);
      return null;
    }
    return user;
  };
  const needsTerms = (userId: string, reply: FastifyReply) => {
    if (ai.acceptedTerms(userId)) return false;
    void bad(reply, 'Please read and accept the AI assistant notice first', 409);
    return true;
  };

  app.get<P>('/api/assistant/mailbox/:accountId', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    return { settings: ai.mailbox(user.id, req.params.accountId), rules: ai.listRules(user.id, req.params.accountId) };
  });

  app.put<P>('/api/assistant/mailbox/:accountId/settings', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    if (needsTerms(user.id, reply)) return reply;
    const body = z.object({ enabled: z.boolean(), connectionId: z.string().max(64).nullable(), accuracy: z.number().int().min(1).max(4) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    if (body.data.connectionId && !ai.connection(user.id, body.data.connectionId, true)) return bad(reply, 'AI connection not found', 404);
    if (body.data.enabled && !body.data.connectionId) return bad(reply, 'Choose an AI connection before switching the assistant on');
    ai.saveMailbox(user.id, { accountId: req.params.accountId, ...body.data });
    engine.syncWatching(user.id);
    return ai.mailbox(user.id, req.params.accountId);
  });

  app.post<P>('/api/assistant/mailbox/:accountId/rules', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    const body = ruleSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'A rule needs a name and at least one action');
    ai.saveRule(user.id, req.params.accountId, null, body.data as RuleInput);
    return ai.listRules(user.id, req.params.accountId);
  });
  app.put<{ Params: { accountId: string; id: string } }>('/api/assistant/mailbox/:accountId/rules/:id', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    const body = ruleSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'A rule needs a name and at least one action');
    if (!ai.saveRule(user.id, req.params.accountId, req.params.id, body.data as RuleInput)) return bad(reply, 'Rule not found', 404);
    return ai.listRules(user.id, req.params.accountId);
  });
  app.delete<{ Params: { accountId: string; id: string } }>('/api/assistant/mailbox/:accountId/rules/:id', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    if (!ai.deleteRule(user.id, req.params.accountId, req.params.id)) return bad(reply, 'Rule not found', 404);
    return ai.listRules(user.id, req.params.accountId);
  });
  app.put<P>('/api/assistant/mailbox/:accountId/rules-order', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    const body = z.object({ ids: z.array(z.string().max(64)).max(500) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    ai.reorderRules(user.id, req.params.accountId, body.data.ids);
    return ai.listRules(user.id, req.params.accountId);
  });

  /** What the rules (or one draft rule) would do with the newest messages; nothing is changed. */
  app.post<P>('/api/assistant/mailbox/:accountId/preview', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    if (needsTerms(user.id, reply)) return reply;
    const body = z.object({ limit: z.number().int().min(1).max(100).default(25), rule: ruleSchema.optional() }).safeParse(req.body ?? {});
    if (!body.success) return bad(reply, 'Invalid request');
    try {
      const draft = body.data.rule ? [{ ...(body.data.rule as RuleInput), id: 'draft', enabled: true }] : undefined;
      return { decisions: await engine.preview(user.id, req.params.accountId, body.data.limit, draft) };
    } catch (err) {
      return bad(reply, (err as Error).message, err instanceof AiError ? 400 : 502);
    }
  });

  /** Do what a rule says to one message now (from the preview). */
  app.post<P>('/api/assistant/mailbox/:accountId/apply', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    if (needsTerms(user.id, reply)) return reply;
    const body = z.object({ ruleId: z.string().max(64), folder: z.string().max(1000), uidValidity: z.string().max(20), uid: z.number().int().positive(), subject: z.string().max(1000).default(''), from: z.string().max(1000).default('') }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    const rule = ai.listRules(user.id, req.params.accountId).find((r) => r.id === body.data.ruleId);
    if (!rule) return bad(reply, 'Rule not found', 404);
    try {
      const m = { folder: body.data.folder, uidValidity: body.data.uidValidity, uid: body.data.uid };
      const undo = await engine.apply(user.id, req.params.accountId, m, rule.actions);
      ai.addHistory(user.id, req.params.accountId, 'manual', { ...m, subject: body.data.subject, from: body.data.from, date: new Date().toISOString(), ruleId: rule.id, ruleName: rule.name, reason: 'Applied from the preview', actions: rule.actions }, undo);
      return { ok: true };
    } catch (err) {
      return bad(reply, (err as Error).message, 502);
    }
  });

  // ---- learning mode -----------------------------------------------------------------------

  /** Mailboxes whose learning ended and want their review (the app opens the assistant for them). */
  app.get('/api/assistant/reviews-due', async (req) => (engine.allowed(req.user!) ? ai.reviewsDue(req.user!.id) : []));

  app.get<P>('/api/assistant/mailbox/:accountId/learning', async (req, reply) => {
    const user = mailbox(req, reply);
    return user ? ai.learning(user.id, req.params.accountId) : reply;
  });

  /** Start learning for `days` (or extend a running period); never more than 30 days in all. */
  app.post<P>('/api/assistant/mailbox/:accountId/learning', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    if (needsTerms(user.id, reply)) return reply;
    const body = z.object({ days: z.number().int().min(1).max(30) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Choose between 1 and 30 days');
    if (!ai.mailbox(user.id, req.params.accountId).connectionId) return bad(reply, 'Choose an AI connection in Setup first');
    const now = Date.now();
    const cur = ai.learning(user.id, req.params.accountId);
    const day = 86_400_000;
    if (cur.active && cur.from && cur.until) {
      const max = Date.parse(cur.from) + 30 * day;
      ai.startLearning(user.id, req.params.accountId, Math.min(max, Date.parse(cur.until) + body.data.days * day), false);
    } else {
      ai.startLearning(user.id, req.params.accountId, now + body.data.days * day, true);
    }
    engine.syncWatching(user.id);
    return ai.learning(user.id, req.params.accountId);
  });

  app.post<P>('/api/assistant/mailbox/:accountId/learning/stop', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    ai.stopLearning(user.id, req.params.accountId);
    engine.syncWatching(user.id);
    return ai.learning(user.id, req.params.accountId);
  });

  app.post<P>('/api/assistant/mailbox/:accountId/learning/suggest', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    if (needsTerms(user.id, reply)) return reply;
    try {
      return { suggestions: await engine.suggest(user.id, req.params.accountId) };
    } catch (err) {
      return bad(reply, (err as Error).message, err instanceof AiError ? 400 : 502);
    }
  });

  /** The review is finished (done) or postponed by a day (later). */
  app.post<{ Params: { accountId: string; what: string } }>('/api/assistant/mailbox/:accountId/learning/:what', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    if (req.params.what !== 'done' && req.params.what !== 'later') return bad(reply, 'Not found', 404);
    ai.setReviewAfter(user.id, req.params.accountId, req.params.what === 'done' ? 0 : Date.now() + 86_400_000);
    return ai.learning(user.id, req.params.accountId);
  });

  // ---- one-time cleanup and senders ----------------------------------------------------------

  app.get<P>('/api/assistant/mailbox/:accountId/scan', async (req, reply) => {
    const user = mailbox(req, reply);
    return user ? engine.scanStatus(user.id, req.params.accountId) : reply;
  });
  app.post<P>('/api/assistant/mailbox/:accountId/scan', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    if (needsTerms(user.id, reply)) return reply;
    const body = z.object({ limit: z.number().int().min(1).max(5000) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    try {
      return engine.startScan(user.id, req.params.accountId, body.data.limit);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
  app.post<P>('/api/assistant/mailbox/:accountId/scan/stop', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    engine.stopScan(user.id, req.params.accountId);
    return engine.scanStatus(user.id, req.params.accountId);
  });

  app.get<{ Params: { accountId: string }; Querystring: { limit?: string } }>('/api/assistant/mailbox/:accountId/senders', async (req, reply) => {
    const user = allowed(req, reply);
    if (!user) return reply;
    if (!ownsAccount(user.id, req.params.accountId)) return bad(reply, 'Mailbox not found', 404);
    const limit = Math.min(5000, Math.max(50, Number(req.query.limit) || 1000));
    try {
      return await engine.senders(user.id, req.params.accountId, limit);
    } catch (err) {
      return bad(reply, (err as Error).message, 502);
    }
  });
  app.post<P>('/api/assistant/mailbox/:accountId/senders/archive', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    const body = z.object({ address: z.string().trim().min(3).max(320) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    try {
      return { archived: await engine.archiveSender(user.id, req.params.accountId, body.data.address) };
    } catch (err) {
      return bad(reply, (err as Error).message, 502);
    }
  });

  /**
   * One-click unsubscribe (RFC 8058): DreyMail posts "List-Unsubscribe=One-Click" to the sender's
   * https address. Senders without one-click get their link or address back to open.
   */
  app.post<P>('/api/assistant/mailbox/:accountId/senders/unsubscribe', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    const body = z.object({ oneClick: z.string().url().max(2000) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    const url = new URL(body.data.oneClick);
    if (url.protocol !== 'https:') return bad(reply, 'Only https unsubscribe links are followed');
    try {
      await assertPublicHost(url.hostname);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15_000);
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click', redirect: 'manual', signal: ctl.signal }).finally(() => clearTimeout(timer));
      if (res.status >= 400) return bad(reply, `The sender's server answered ${res.status}; try their unsubscribe page instead`, 502);
      return { ok: true };
    } catch (err) {
      return bad(reply, `Could not unsubscribe: ${(err as Error).message}`, 502);
    }
  });

  app.get<P>('/api/assistant/mailbox/:accountId/history', async (req, reply) => {
    const user = mailbox(req, reply);
    return user ? ai.listHistory(user.id, req.params.accountId) : reply;
  });

  app.post<{ Params: { accountId: string; id: string } }>('/api/assistant/mailbox/:accountId/history/:id/undo', async (req, reply) => {
    const user = mailbox(req, reply);
    if (!user) return reply;
    try {
      if (!(await engine.undo(user.id, req.params.accountId, Number(req.params.id)))) return bad(reply, 'This can no longer be undone');
      return ai.listHistory(user.id, req.params.accountId);
    } catch (err) {
      return bad(reply, `Could not undo: ${(err as Error).message}`, 502);
    }
  });
}
