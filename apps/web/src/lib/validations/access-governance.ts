import { z } from 'zod';
import { ACTIONS } from '@/lib/rbac/capabilities';

/** Access governance (05-RBAC-SPEC R-9 / R-10) request schemas. */

const uuid = z.string().uuid();
const optionalUuid = z.preprocess((v) => (v === '' || v === null ? undefined : v), uuid.optional());
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');

export const accessLogQuerySchema = z.object({
  member: optionalUuid,
  client: optionalUuid,
  group: z.enum(['grants', 'removals', 'changes', 'roles', 'reviews', 'requests']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().max(100).optional(),
  before: z.coerce.number().int().positive().optional(), // seq cursor
  limit: z.coerce.number().int().min(1).max(200).default(50),
  format: z.enum(['json', 'csv']).default('json'),
});
export type AccessLogQuery = z.infer<typeof accessLogQuerySchema>;

export const reviewStartSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the review').max(200),
    scopeKind: z.enum(['all', 'client', 'role']),
    locationId: optionalUuid,
    roleId: optionalUuid,
    dueAt: isoDate,
    reviewerMembershipId: optionalUuid,
    autoRevokeUnreviewed: z.boolean().default(false),
  })
  .refine((v) => v.scopeKind !== 'client' || !!v.locationId, { message: 'Pick a client', path: ['locationId'] })
  .refine((v) => v.scopeKind !== 'role' || !!v.roleId, { message: 'Pick a role', path: ['roleId'] })
  .refine((v) => Date.parse(v.dueAt) > Date.now(), { message: 'Pick a due date in the future', path: ['dueAt'] });

export const reviewItemsQuerySchema = z.object({ reviewId: uuid });

export const reviewDecideSchema = z
  .object({
    itemId: uuid,
    decision: z.enum(['keep', 'reduce', 'revoke', 'delegate']),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((v) => (v.decision !== 'reduce' && v.decision !== 'delegate') || !!v.note, {
    message: 'Say what should change',
    path: ['note'],
  });

export const reviewCloseSchema = z.object({ reviewId: uuid });

export const accessRequestCreateSchema = z
  .object({
    kind: z.enum(['capability', 'role', 'permission_set', 'client']),
    capability: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/).optional(),
    actions: z.array(z.enum(ACTIONS)).max(9).optional(),
    roleId: optionalUuid,
    permissionSetId: optionalUuid,
    locationId: optionalUuid,
    durationDays: z.number().int().min(1).max(365).nullable().optional(),
    reason: z.string().trim().min(3, 'Tell the approver why (a few words)').max(2000),
  })
  .refine((v) => v.kind !== 'capability' || (!!v.capability && (v.actions?.length ?? 0) > 0), {
    message: 'Say what you need to do',
    path: ['actions'],
  })
  .refine((v) => v.kind !== 'role' || !!v.roleId, { message: 'Pick a role', path: ['roleId'] })
  .refine((v) => v.kind !== 'permission_set' || !!v.permissionSetId, { message: 'Pick a permission set', path: ['permissionSetId'] })
  .refine((v) => v.kind !== 'client' || !!v.locationId, { message: 'Pick a client', path: ['locationId'] });
export type AccessRequestCreate = z.infer<typeof accessRequestCreateSchema>;

export const accessRequestDecideSchema = z
  .object({
    requestId: uuid,
    decision: z.enum(['approve', 'deny', 'confirm']),
    note: z.string().trim().max(1000).optional(),
    roleId: optionalUuid,
    durationDays: z.number().int().min(1).max(365).nullable().optional(),
  })
  .refine((v) => v.decision !== 'deny' || !!v.note, { message: 'Tell them why', path: ['note'] });

export const accessRequestCancelSchema = z.object({ requestId: uuid });

export const templateUpdateDecideSchema = z
  .object({
    updateId: uuid,
    add: z.array(z.string().min(1).max(200)).max(500).default([]),
    skip: z.array(z.string().min(1).max(200)).max(500).default([]),
    publish: z.boolean().default(false),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.add.length + v.skip.length > 0, { message: 'Nothing to save', path: ['add'] })
  .refine((v) => !v.publish || !!v.reason, { message: 'Give a reason for publishing', path: ['reason'] });
