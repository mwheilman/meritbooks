import { z } from 'zod';

// =============================================================
// VENDORS
// =============================================================

export const createVendorSchema = z.object({
  name: z.string().min(1).max(200),
  display_name: z.string().max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  address_line1: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(2).optional(),
  zip: z.string().max(10).optional(),
  payment_terms_days: z.number().int().min(0).max(365).default(30),
  is_1099_eligible: z.boolean().default(false),
  default_account_id: z.string().uuid().optional(),
});

export const updateVendorComplianceSchema = z.object({
  vendor_id: z.string().uuid(),
  doc_type: z.enum(['W9', 'GL_COI', 'WC_COI', 'WC_EXEMPTION']),
  file_url: z.string().url(),
  issued_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expiration_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  coverage_amount_cents: z.number().int().optional(),
});

// =============================================================
// JOBS
// =============================================================

export const createJobSchema = z.object({
  location_id: z.string().uuid(),
  job_number: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  customer_name: z.string().max(200).optional(),
  customer_id: z.string().uuid().optional(),
  job_type: z.enum(['CONSTRUCTION', 'HVAC', 'CABINETRY', 'SERVICE', 'MAINTENANCE', 'OTHER']).optional(),
  contract_amount_cents: z.number().int().min(0).optional(),
  estimated_cost_cents: z.number().int().min(0).optional(),
  budget_labor_cents: z.number().int().min(0).default(0),
  budget_materials_cents: z.number().int().min(0).default(0),
  budget_subcontractor_cents: z.number().int().min(0).default(0),
  budget_other_cents: z.number().int().min(0).default(0),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  estimated_completion_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  rev_rec_method: z.enum(['PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'COMPLETED_CONTRACT', 'POINT_OF_SALE']).optional(),
});

export const createChangeOrderSchema = z.object({
  job_id: z.string().uuid(),
  change_order_number: z.string().min(1).max(50),
  description: z.string().min(1).max(1000),
  amount_cents: z.number().int(),
});

// =============================================================
// INVOICES (AR)
// =============================================================

export const createInvoiceSchema = z.object({
  location_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  job_id: z.string().uuid().optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  is_progress_bill: z.boolean().default(false),
  application_number: z.number().int().optional(),
  memo: z.string().max(500).optional(),
  lines: z.array(z.object({
    description: z.string().max(500),
    account_id: z.string().uuid(),
    quantity: z.number().min(0).default(1),
    unit_price_cents: z.number().int().min(0),
    amount_cents: z.number().int(),
    job_phase_id: z.string().uuid().optional(),
    cost_code_id: z.string().uuid().optional(),
  })).min(1, 'Invoice must have at least one line'),
  tax_cents: z.number().int().min(0).default(0),
  retainage_cents: z.number().int().min(0).default(0),
});

export const recordPaymentSchema = z.object({
  customer_id: z.string().uuid(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_cents: z.number().int().min(1),
  payment_method: z.enum(['CHECK', 'ACH', 'WIRE', 'CREDIT_CARD', 'CASH', 'OTHER']),
  reference_number: z.string().max(50).optional(),
  bank_account_id: z.string().uuid(),
  applications: z.array(z.object({
    invoice_id: z.string().uuid(),
    amount_cents: z.number().int().min(1),
  })).min(1),
});

// =============================================================
// TYPE EXPORTS
// =============================================================

export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
