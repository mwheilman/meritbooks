/**
 * Zod schemas for the PBC + external-auditor-access API surface.
 */

import { z } from 'zod';
import { PBC_STATUSES, PBC_CATEGORIES } from '@/lib/audit-access/pbc';

const dateStr = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** Create a PBC request (the auditor's ask). */
export const createPbcSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).optional(),
  category: z.enum(PBC_CATEGORIES).optional(),
  periodLabel: z.string().trim().max(40).optional(),
  dueDate: dateStr.optional(),
  /** core.employees.id of the client user responsible (optional at creation). */
  assignedTo: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  notes: z.string().trim().max(4000).optional(),
});
export type CreatePbcInput = z.infer<typeof createPbcSchema>;

/**
 * Update a PBC request. Every field is optional; the route derives the required tier
 * (requester vs fulfiller) from WHICH fields changed. `documentId`/`assignedTo` accept
 * null to detach/unassign.
 */
export const updatePbcSchema = z
  .object({
    status: z.enum(PBC_STATUSES).optional(),
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    category: z.enum(PBC_CATEGORIES).nullable().optional(),
    periodLabel: z.string().trim().max(40).nullable().optional(),
    dueDate: dateStr.nullable().optional(),
    assignedTo: z.string().uuid().nullable().optional(),
    documentId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdatePbcInput = z.infer<typeof updatePbcSchema>;

/** Query filters for the PBC list. */
export const listPbcQuery = z.object({
  status: z.enum(PBC_STATUSES).optional(),
  period: z.string().trim().max(40).optional(),
  assignedTo: z.string().uuid().optional(),
  overdue: z.enum(['1']).optional(),
});
export type ListPbcQuery = z.infer<typeof listPbcQuery>;

/** Invite an external auditor (provisions the read-only role + a pending seat). */
export const inviteAuditorSchema = z.object({
  email: z.string().email().max(200),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  /** Companies the auditor may view. Empty ⇒ grant every company in the org. */
  companyIds: z.array(z.string().uuid()).default([]),
});
export type InviteAuditorInput = z.infer<typeof inviteAuditorSchema>;
