import { z } from 'zod';
import { APPROVAL_OBJECT_TYPES, APPROVAL_TABS } from '@/lib/approvals/types';

export const ObjectType = z.enum(APPROVAL_OBJECT_TYPES);
export const Reason = z.string().trim().max(2000);
export const ChannelSchema = z.enum(['web', 'phone', 'api']).default('web');

/** GET /api/approvals — `?mine` (phone shorthand for tab=mine), tab, type (comma list), job, overdue. */
export const InboxQuery = z.object({
  mine: z.string().optional(),
  tab: z.enum(APPROVAL_TABS).optional(),
  type: z.string().max(400).optional(),
  companyId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  overdue: z.enum(['1', 'true', '0', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const DecideBody = z.object({
  objectType: ObjectType,
  objectId: z.string().uuid(),
  decision: z.enum(['approve', 'reject', 'submit']).default('approve'),
  reason: Reason.nullish(),
  selfReason: Reason.nullish(),
  ref: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).nullish(),
  channel: ChannelSchema,
});

export const ApproveBody = z.object({ reason: Reason.nullish(), selfReason: Reason.nullish(), channel: ChannelSchema });
export const RejectBody = z.object({ reason: Reason.min(1, 'Say why you are sending it back.'), channel: ChannelSchema });
export const CancelBody = z.object({ reason: Reason.nullish() });
export const BulkBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  decision: z.enum(['approve', 'reject']),
  reason: Reason.nullish(),
  channel: ChannelSchema,
});
