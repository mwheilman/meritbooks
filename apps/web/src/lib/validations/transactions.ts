import { z } from 'zod';

// =============================================================
// BANK TRANSACTIONS
// =============================================================

export const approveBankTransactionSchema = z.object({
  transaction_id: z.string().uuid(),
  account_id: z.string().uuid('GL account is required'),
  vendor_id: z.string().uuid().optional().nullable(),
  department_id: z.string().uuid().optional().nullable(),
  class_id: z.string().uuid().optional().nullable(),
});

export const batchApproveSchema = z.object({
  transaction_ids: z.array(z.string().uuid()).min(1, 'Select at least one transaction').max(100),
});

export const flagTransactionSchema = z.object({
  transaction_id: z.string().uuid(),
  reason: z.string().min(1, 'Flag reason is required').max(500),
});

// =============================================================
// RECEIPTS
// =============================================================

export const submitReceiptSchema = z.object({
  location_id: z.string().uuid(),
  source: z.enum(['MOBILE_CAPTURE', 'EMAIL', 'MANUAL_UPLOAD']),
  image_url: z.string().url().optional(),
  vendor_name: z.string().max(200).optional(),
  amount_cents: z.number().int().min(1).optional(),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  account_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional().nullable(),
});

export const approveReceiptSchema = z.object({
  receipt_id: z.string().uuid(),
  account_id: z.string().uuid('GL account is required'),
  vendor_id: z.string().uuid().optional().nullable(),
  amount_cents: z.number().int().min(1, 'Amount is required'),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date is required'),
  department_id: z.string().uuid().optional().nullable(),
  class_id: z.string().uuid().optional().nullable(),
});

// =============================================================
// BILLS
// =============================================================

export const createBillSchema = z.object({
  location_id: z.string().uuid(),
  vendor_id: z.string().uuid('Vendor is required'),
  bill_number: z.string().max(50).optional(),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(z.object({
    description: z.string().max(500).optional(),
    account_id: z.string().uuid(),
    department_id: z.string().uuid().optional().nullable(),
    class_id: z.string().uuid().optional().nullable(),
    item_id: z.string().uuid().optional().nullable(),
    quantity: z.number().min(0).default(1),
    unit_cost_cents: z.number().int().min(0),
    amount_cents: z.number().int(),
    job_id: z.string().uuid().optional().nullable(),
  })).min(1, 'Bill must have at least one line'),
  tax_cents: z.number().int().min(0).default(0),
});

export const approveBillSchema = z.object({
  bill_id: z.string().uuid(),
});

// =============================================================
// TYPE EXPORTS
// =============================================================

export type ApproveBankTransactionInput = z.infer<typeof approveBankTransactionSchema>;
export type BatchApproveInput = z.infer<typeof batchApproveSchema>;
export type FlagTransactionInput = z.infer<typeof flagTransactionSchema>;
export type SubmitReceiptInput = z.infer<typeof submitReceiptSchema>;
export type ApproveReceiptInput = z.infer<typeof approveReceiptSchema>;
export type CreateBillInput = z.infer<typeof createBillSchema>;
