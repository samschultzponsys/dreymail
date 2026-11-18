// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Contacts and tasks API (DreyMail 10.4). /api's preHandler has authenticated the user.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PeopleError, type People } from '../people.js';

const contactSchema = z.object({
  name: z.string().trim().max(300).default(''),
  emails: z.array(z.string().trim().max(320)).max(20).default([]),
  phones: z.array(z.string().trim().max(60)).max(20).default([]),
  company: z.string().trim().max(300).default(''),
  title: z.string().trim().max(300).default(''),
  notes: z.string().max(10_000).default(''),
  source: z.enum(['local', 'microsoft', 'google']).optional(),
  accountId: z.string().max(64).nullable().optional(),
});
const taskSchema = z.object({
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(10_000).default(''),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  done: z.boolean().default(false),
});

export function registerPeopleRoutes(app: FastifyInstance, deps: { people: People }) {
  const { people } = deps;
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PeopleError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };
  const run = <T>(reply: FastifyReply, f: () => Promise<T> | T) => Promise.resolve().then(f).catch((err: unknown) => fail(reply, err));

  app.get('/api/people/sources', async (req) => people.sources(req.user!.id));

  app.get('/api/contacts', async (req, reply) => run(reply, () => people.contacts(req.user!.id)));
  app.post('/api/contacts', async (req, reply) => {
    const body = contactSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Check the contact' });
    if (!body.data.name && !body.data.emails.length) return reply.code(400).send({ error: 'Give the contact a name or an email address' });
    return run(reply, () => people.saveContact(req.user!.id, null, body.data));
  });
  app.put<{ Params: { id: string } }>('/api/contacts/:id', async (req, reply) => {
    const body = contactSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Check the contact' });
    return run(reply, () => people.saveContact(req.user!.id, req.params.id, body.data));
  });
  app.delete<{ Params: { id: string } }>('/api/contacts/:id', async (req, reply) => run(reply, async () => (await people.deleteContact(req.user!.id, req.params.id), { ok: true })));

  app.get('/api/tasklists', async (req, reply) => run(reply, () => people.lists(req.user!.id)));
  app.post('/api/tasklists', async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Give the list a name' });
    return people.addList(req.user!.id, body.data.name);
  });
  app.get<{ Params: { list: string } }>('/api/tasklists/:list/tasks', async (req, reply) => run(reply, () => people.tasks(req.user!.id, req.params.list)));
  app.post<{ Params: { list: string } }>('/api/tasklists/:list/tasks', async (req, reply) => {
    const body = taskSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Give the task a title' });
    return run(reply, () => people.saveTask(req.user!.id, req.params.list, null, body.data));
  });
  app.put<{ Params: { list: string; id: string } }>('/api/tasklists/:list/tasks/:id', async (req, reply) => {
    const body = taskSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Give the task a title' });
    return run(reply, () => people.saveTask(req.user!.id, req.params.list, req.params.id, body.data));
  });
  app.delete<{ Params: { list: string; id: string } }>('/api/tasklists/:list/tasks/:id', async (req, reply) => run(reply, async () => (await people.deleteTask(req.user!.id, req.params.list, req.params.id), { ok: true })));
}
