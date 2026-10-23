/**
 * Zod schemas for the request engine + notifications routes (migration 178,
 * FPB-request-engine-notifications). Literals mirror the migration CHECKs.
 */
import { z } from 'zod';
import { CHANNELS, POLICY_KEYS, REQUEST_KINDS } from '@/lib/requests/types';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

export const requestListQuery = z.object({
  /** Defaults (no zod .default — apiQueryHandler needs input = output): live. */
  view: z.enum(['live', 'closed', 'all']).optional(),
  /** Strip band (live view): due in the next 24h · escalated · can't be delivered. Default all. */
  band: z.enum(['all', 'due', 'escalated', 'undeliverable']).optional(),
  /** One kind or a comma list ("w9,coi"). */
  kind: z
    .string()
    .max(120)
    .regex(/^[a-z_]+(,[a-z_]+)*$/, 'Unknown request kind')
    .refine((v) => v.split(',').every((k) => (REQUEST_KINDS as readonly string[]).includes(k)), 'Unknown request kind')
    .optional(),
  location_id: uuid.optional(),
  q: z.string().max(100).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
  offset: z.string().regex(/^\d{1,6}$/).optional(),
});
export type RequestListQuery = z.infer<typeof requestListQuery>;

export const requestDetailQuery = z.object({ id: uuid });

export const createRequestBody = z
  .object({
    kind: z.enum(REQUEST_KINDS),
    location_id: uuid.nullish(),
    /** w9 / coi: the vendor being asked (uses the vendor-portal link). */
    vendor_id: uuid.optional(),
    /** coi: ask for the renewal of a certificate expiring on due_date. */
    renewal: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    message: z.string().trim().max(4000).optional(),
    /** Default 'email'. */
    recipient_type: z.enum(['member', 'email', 'vendor_contact', 'customer_contact', 'employee']).optional(),
    recipient_membership_id: uuid.optional(),
    recipient_name: z.string().trim().max(200).optional(),
    recipient_email: z.string().trim().email().max(320).optional(),
    recipient_timezone: z.string().trim().max(64).optional(),
    channels: z.array(z.enum(CHANNELS)).min(1).max(4).optional(),
    due_date: isoDate.optional(),
    escalate_to_membership_id: uuid.optional(),
  })
  .superRefine((b, ctx) => {
    if ((b.kind === 'w9' || b.kind === 'coi') && !b.vendor_id) ctx.addIssue({ code: 'custom', path: ['vendor_id'], message: 'Pick the vendor.' });
    if (b.kind !== 'w9' && b.kind !== 'coi' && !b.title) ctx.addIssue({ code: 'custom', path: ['title'], message: 'What are you asking for?' });
    if (b.kind === 'receipt') ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Receipt requests are created from card charges (Receipt chase).' });
    if (b.recipient_type === 'member' && !b.recipient_membership_id) ctx.addIssue({ code: 'custom', path: ['recipient_membership_id'], message: 'Pick the team member.' });
    if (b.recipient_type !== 'member' && !b.vendor_id && !b.recipient_email) ctx.addIssue({ code: 'custom', path: ['recipient_email'], message: 'Add an email address.' });
    if (b.renewal && !b.due_date) ctx.addIssue({ code: 'custom', path: ['due_date'], message: 'A renewal needs the expiry date.' });
  });
export type CreateRequestBody = z.infer<typeof createRequestBody>;

export const requestActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send_now'), id: uuid }),
  z.object({ action: z.literal('snooze'), id: uuid, until: z.string().datetime({ offset: true }) }),
  z.object({ action: z.literal('cancel'), id: uuid, reason: z.string().trim().min(1, 'Say why.').max(500) }),
  z.object({ action: z.literal('fulfil'), id: uuid, note: z.string().trim().max(500).optional() }),
]);
export type RequestActionBody = z.infer<typeof requestActionBody>;

const minutes = z.number().int();
export const policyRowBody = z.object({
  policy_key: z.enum(POLICY_KEYS),
  auto_create: z.boolean().optional(),
  cadence_offsets_minutes: z.array(minutes.min(-525_600).max(525_600)).min(1).max(12).nullable().optional(),
  repeat_every_minutes: minutes.min(15).max(525_600).nullable().optional(),
  max_sends: minutes.min(1).max(100).nullable().optional(),
  escalate_after: minutes.min(1).max(100).nullable().optional(),
  quiet_start: hhmm.nullable().optional(),
  quiet_end: hhmm.nullable().optional(),
  timezone: z.string().trim().max(64).nullable().optional(),
});
export const policiesPutBody = z.object({ policies: z.array(policyRowBody).min(1).max(POLICY_KEYS.length) });
export type PoliciesPutBody = z.infer<typeof policiesPutBody>;

export const notificationsQuery = z.object({
  limit: z.string().regex(/^\d{1,3}$/).optional(),
  unread: z.enum(['1', '0']).optional(),
});
export const notificationsMarkBody = z
  .object({ ids: z.array(uuid).max(200).optional(), all: z.boolean().optional() })
  .refine((b) => b.all === true || (b.ids && b.ids.length > 0), 'Say which notifications to mark read.');

export const notificationPrefsBody = z.object({
  digest: z.enum(['instant', 'daily', 'weekly', 'off']),
  channels: z.array(z.enum(['in_app', 'email'])).min(1).max(2).optional(),
});
