import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { fsCall, fsOwn } from '@/lib/fieldservice/rpc';
import { loadMessageTemplates, loadThreadMessages, loadThreads } from '@/lib/fieldservice/completion';
import { Text, Uuid } from '@/lib/pm/ops/schemas';

/**
 * Two-way customer messaging (FS-12). GET ?companyId= lists open threads (unread first) and the
 * company's templates; GET ?threadId= one thread's messages. POST sends a text / email through the
 * notifications service (consent, STOP, quiet hours and the go-live hold all apply — the answer
 * says whether it is queued, held or suppressed and why), adds an internal note, marks read / closes.
 */
const Q = z.object({ companyId: Uuid.optional(), threadId: Uuid.optional(), status: z.enum(['OPEN', 'CLOSED']).optional() });

export const GET = route({ access: { cap: 'projects.customers', action: 'view' }, mask: false, query: Q }, async ({ db, tenant, query }) => {
  if (query.threadId) {
    const t = await fsOwn<{ id: string; location_id: string }>(db, 'fs_threads', 'id, location_id', query.threadId, 'That conversation was not found.');
    assertCompany(tenant, t.location_id);
    const m = await loadThreadMessages(db, t.id);
    return { messages: m.data, error: m.error };
  }
  if (!query.companyId) throw new HttpError(422, 'Pick the company.', 'VALIDATION');
  assertCompany(tenant, query.companyId);
  const [threads, templates] = await Promise.all([loadThreads(db, query.companyId, query.status ?? 'OPEN'), loadMessageTemplates(db, query.companyId)]);
  return { threads: threads.data, templates: templates.data, error: threads.error };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('send'), companyId: Uuid, customerId: Uuid, jobId: Uuid.nullish(), workOrderId: Uuid.nullish(), contactId: Uuid.nullish(),
             channel: z.enum(['SMS', 'EMAIL']).default('SMS'), body: Text(1600).default(''), template: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).nullish(),
             commandId: Uuid.nullish() }),
  z.object({ op: z.literal('note'), threadId: Uuid, body: z.string().trim().min(1).max(4000) }),
  z.object({ op: z.literal('mark'), threadId: Uuid, action: z.enum(['READ', 'CLOSE', 'REOPEN']) }),
]);

export const POST = route({ access: { cap: 'projects.customers', action: 'view' }, mask: false, body: Body }, async ({ db, body }) => {
  switch (body.op) {
    case 'send':
      if (!body.template && !body.body) throw new HttpError(422, 'Type the message or pick a template.', 'VALIDATION');
      return fsCall(db, 'fs_send_message', {
        p_location: body.companyId, p_customer: body.customerId, p_job: body.jobId ?? null, p_channel: body.channel, p_body: body.body || null,
        p_contact: body.contactId ?? null, p_template: body.template ?? null, p_work_order: body.workOrderId ?? null, p_vals: null, p_command: body.commandId ?? null,
      });
    case 'note':
      return { id: await fsCall<string>(db, 'fs_add_thread_note', { p_thread: body.threadId, p_body: body.body }) };
    case 'mark':
      return { id: await fsCall<string>(db, 'fs_mark_thread', { p_thread: body.threadId, p_action: body.action }) };
  }
});
