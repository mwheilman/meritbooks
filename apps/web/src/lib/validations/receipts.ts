/**
 * Zod schemas for the receipt capture & chase routes (migration 181, FPB-workforce-app §15).
 */
import { z } from 'zod';

const uuid = z.string().uuid();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const chaseListQuery = z.object({
  location_id: uuid.optional(),
  q: z.string().max(100).optional(),
  /** "1" = also list the charges older than the chase window that never got a receipt. */
  include_older: z.enum(['0', '1']).optional(),
});

export const chaseActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('remind'), transaction_id: uuid }),
  z.object({ action: z.literal('not_required'), transaction_id: uuid, reason: z.string().trim().min(3, 'Say why').max(500) }),
  z.object({ action: z.literal('reopen'), transaction_id: uuid }),
  z.object({ action: z.literal('reassign'), transaction_id: uuid, assignment_id: uuid }),
]);
export type ChaseActionBody = z.infer<typeof chaseActionBody>;

export const cardholderBody = z.object({
  location_id: uuid,
  bank_account_id: uuid.nullable().optional(),
  card_last4: z.string().regex(/^\d{4}$/, 'Four digits').nullable().optional(),
  card_label: z.string().max(80).nullable().optional(),
  holder_type: z.enum(['member', 'employee', 'external']),
  membership_id: uuid.nullable().optional(),
  employee_id: uuid.nullable().optional(),
  holder_name: z.string().trim().min(1).max(200),
  holder_email: z.string().trim().email().max(320).nullable().optional().or(z.literal('')),
  holder_phone: z.string().trim().max(32).nullable().optional().or(z.literal('')),
  holder_timezone: z.string().max(64).nullable().optional(),
  manager_membership_id: uuid.nullable().optional(),
  starts_on: ymd.nullable().optional(),
  ends_on: ymd.nullable().optional(),
});
export type CardholderBody = z.infer<typeof cardholderBody>;

export const cardholderActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update'), data: cardholderBody }),
  z.object({ action: z.literal('end') }),
  z.object({ action: z.literal('request_opt_out'), reason: z.string().trim().min(5, 'Say why (a few words)').max(500) }),
  z.object({ action: z.literal('approve_opt_out') }),
  z.object({ action: z.literal('reject_opt_out') }),
  z.object({ action: z.literal('clear_opt_out') }),
]);
export type CardholderActionBody = z.infer<typeof cardholderActionBody>;

export const receiptPolicyBody = z.object({
  location_id: uuid.nullable(),
  /** Client rows only: drop the client override and follow the tenant again. */
  reset: z.boolean().optional(),
  patch: z
    .object({
      receiptRequiredOverCents: z.number().int().min(0).max(100_000_000).nullable(),
      memoRequired: z.boolean().nullable(),
      memoRequiredOverCents: z.number().int().min(0).max(100_000_000).nullable(),
      graceDays: z.number().int().min(0).max(30).nullable(),
      chaseWindowDays: z.number().int().min(1).max(365).nullable(),
      reminderDays: z.array(z.number().int().min(0).max(90)).min(1).max(12).nullable(),
      escalateTo: z.enum(['manager', 'bookkeeper', 'none']).nullable(),
      bookkeeperMembershipId: uuid.nullable(),
      amountToleranceCents: z.number().int().min(0).max(100_000).nullable(),
      tipToleranceBp: z.number().int().min(0).max(10_000).nullable(),
      dateWindowDays: z.number().int().min(0).max(14).nullable(),
      autoMatchMinScore: z.number().min(0.5).max(1).nullable(),
      suggestMinScore: z.number().min(0.3).max(1).nullable(),
      digestEnabled: z.boolean().nullable(),
    })
    .partial()
    .default({}),
});
export type ReceiptPolicyBody = z.infer<typeof receiptPolicyBody>;

export const chaseSwitchBody = z.object({
  scope: z.enum(['tenant', 'client']),
  location_id: uuid.optional(),
  /** Client: true/false; `follow: true` = follow the tenant (null). */
  enabled: z.boolean(),
  follow: z.boolean().optional(),
  reason: z.string().trim().min(3, 'Say why (it goes on the audit trail)').max(500),
});
export type ChaseSwitchBody = z.infer<typeof chaseSwitchBody>;

export const receiptMatchBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm') }),
  z.object({ action: z.literal('link'), transaction_id: uuid }),
  z.object({ action: z.literal('unmatch') }),
  z.object({ action: z.literal('rematch') }),
  z.object({ action: z.literal('not_required'), reason: z.string().trim().min(3).max(500) }),
]);
export type ReceiptMatchBody = z.infer<typeof receiptMatchBody>;

export const receiptApproveBody = z.object({
  receipt_ids: z.array(uuid).min(1).max(200),
});

export const receiptListQuery = z.object({
  match: z.enum(['all', 'unmatched', 'suggested', 'matched']).optional(),
  status: z.enum(['all', 'PENDING', 'CATEGORIZED', 'FLAGGED', 'APPROVED']).optional(),
  search: z.string().max(200).optional(),
  location_id: uuid.optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

/** Fields of the Workforce / desk upload form (multipart, besides the file). */
export const uploadFields = z.object({
  location_id: uuid.optional(),
  transaction_id: uuid.optional(),
  assignment_id: uuid.optional(),
  memo: z.string().max(1000).optional(),
  job_id: uuid.optional(),
  merchant: z.string().max(120).optional(),
  amount: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Amount like 68.42')
    .optional(),
  date: ymd.optional(),
});
export type UploadFields = z.infer<typeof uploadFields>;
