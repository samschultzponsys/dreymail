// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Settings → Auto-replies: the signed-in user's own auto-replies (out of office, sick, …).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AutoReplies } from '../autoReply.js';

const when = z.string().datetime({ offset: true }).nullable().default(null);
const inputSchema = z
  .object({
    name: z.string().trim().min(1, 'Give it a name').max(80),
    subject: z.string().trim().min(1, 'Enter a subject').max(300),
    body: z.string().trim().min(1, 'Enter a message').max(20_000),
    enabled: z.boolean().default(false),
    startsAt: when,
    endsAt: when,
    allMailboxes: z.boolean().default(false),
    accountIds: z.array(z.string().max(64)).max(200).default([]),
    groupIds: z.array(z.string().max(64)).max(200).default([]),
    intervalDays: z.number().int().min(1).max(30).default(4),
  })
  .refine((r) => !r.startsAt || !r.endsAt || Date.parse(r.endsAt) > Date.parse(r.startsAt), { message: 'The end must be after the start' })
  .refine((r) => r.allMailboxes || r.accountIds.length > 0 || r.groupIds.length > 0, { message: 'Pick the mailboxes or groups it answers for' });

export function registerAutoReplyRoutes(app: FastifyInstance, deps: { autoReplies: AutoReplies; onChanged: (userId: string) => void }) {
  const { autoReplies } = deps;
  const parse = (body: unknown) => {
    const r = inputSchema.safeParse(body);
    return r.success ? { data: r.data } : { error: r.error.issues[0]?.message ?? 'Invalid auto-reply' };
  };

  app.get('/api/auto-replies', async (req) => autoReplies.list(req.user!.id));

  app.post('/api/auto-replies', async (req, reply) => {
    const p = parse(req.body);
    if (!p.data) return reply.code(400).send({ error: p.error });
    autoReplies.save(req.user!.id, p.data);
    deps.onChanged(req.user!.id);
    return autoReplies.list(req.user!.id);
  });

  app.put<{ Params: { id: string } }>('/api/auto-replies/:id', async (req, reply) => {
    const p = parse(req.body);
    if (!p.data) return reply.code(400).send({ error: p.error });
    if (!autoReplies.save(req.user!.id, p.data, req.params.id)) return reply.code(404).send({ error: 'Auto-reply not found' });
    deps.onChanged(req.user!.id);
    return autoReplies.list(req.user!.id);
  });

  app.delete<{ Params: { id: string } }>('/api/auto-replies/:id', async (req, reply) => {
    if (!autoReplies.remove(req.user!.id, req.params.id)) return reply.code(404).send({ error: 'Auto-reply not found' });
    deps.onChanged(req.user!.id);
    return autoReplies.list(req.user!.id);
  });
}
