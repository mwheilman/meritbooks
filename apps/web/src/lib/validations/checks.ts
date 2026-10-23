import { z } from 'zod';

/** Wave 2C check processing — request bodies (FPB-check-processing §7). */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date');
const cents = z.number().int().positive().max(9_999_999_999);
const optText = (max: number) => z.string().max(max).nullable().optional();

export const printChecksSchema = z.object({
  bankAccountId: uuid,
  billPaymentIds: z.array(uuid).min(1, 'Choose at least one check').max(2000),
  checkDate: isoDate.optional(),
  expectedFirstNumber: z.number().int().min(1).max(99_999_999).nullable().optional(),
  memo: optText(200),
});
export type PrintChecksBody = z.infer<typeof printChecksSchema>;

export const alignmentSchema = z.object({
  bankAccountId: uuid,
  offsetXPt: z.number().min(-72).max(72).optional(),
  offsetYPt: z.number().min(-72).max(72).optional(),
  layout: z.enum(['VOUCHER_TOP', 'VOUCHER_MIDDLE', 'VOUCHER_BOTTOM', 'THREE_UP']).optional(),
});

export const checkActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('void'), reason: z.string().trim().min(3, 'Say why').max(500), voidDate: isoDate.optional() }),
  z.object({ action: z.literal('spoil'), reason: z.string().trim().min(3, 'Say why').max(500) }),
  z.object({ action: z.literal('reprint'), reason: z.string().trim().min(3, 'Say why').max(500), checkDate: isoDate.optional() }),
  z.object({ action: z.literal('issue') }),
  z.object({ action: z.literal('mail'), tracking: z.string().max(120).nullable().optional() }),
]);
export type CheckActionBody = z.infer<typeof checkActionSchema>;

const ppField = z.enum(['account', 'routing', 'check_number', 'amount', 'issue_date', 'payee', 'record_code', 'constant', 'filler']);
const ppDate = z.enum(['MMDDYYYY', 'YYYYMMDD', 'MMDDYY', 'YYYY-MM-DD', 'MM/DD/YYYY']);
const ppAmount = z.enum(['CENTS', 'DOLLARS']);

export const csvMappingSchema = z.object({
  columns: z.array(z.object({ field: ppField, header: z.string().max(60), value: z.string().max(60).optional() })).min(3).max(20),
  includeHeader: z.boolean(),
  dateFormat: ppDate,
  amountFormat: ppAmount,
  issueCode: z.string().max(4),
  voidCode: z.string().min(1).max(4),
  delimiter: z.enum([',', '|', '\t']).optional(),
});

export const fixedMappingSchema = z.object({
  fields: z.array(z.object({
    field: ppField,
    start: z.number().int().min(1).max(1000),
    length: z.number().int().min(1).max(200),
    align: z.enum(['left', 'right']),
    pad: z.enum(['0', ' ']),
    value: z.string().max(60).optional(),
  })).min(4).max(30),
  recordLength: z.number().int().min(10).max(1000),
  dateFormat: ppDate,
  amountFormat: ppAmount,
  issueCode: z.string().max(4),
  voidCode: z.string().min(1).max(4),
});

export const stockSettingsSchema = z.object({
  bankAccountId: uuid,
  layout: z.enum(['VOUCHER_TOP', 'VOUCHER_MIDDLE', 'VOUCHER_BOTTOM', 'THREE_UP']),
  offsetXPt: z.number().min(-72).max(72),
  offsetYPt: z.number().min(-72).max(72),
  payerName: optText(200),
  payerAddress: optText(500),
  logoUrl: optText(1000),
  bankName: optText(200),
  bankAddress: optText(500),
  bankFraction: optText(40),
  secondSignatureOverCents: cents.nullable(),
  maxCheckCents: cents.nullable(),
  voidAfterDays: z.number().int().min(30).max(365),
  staleAfterDays: z.number().int().min(30).max(730),
  oneCheckPerBill: z.boolean(),
  auxOnUsDigits: z.number().int().min(4).max(10),
  positivePayFormat: z.enum(['GENERIC_CSV', 'CHASE_STYLE_FIXED', 'BOFA_STYLE_FIXED', 'CUSTOM_CSV', 'CUSTOM_FIXED']),
  positivePayMapping: z.union([csvMappingSchema, fixedMappingSchema]).nullable(),
}).superRefine((v, ctx) => {
  if (v.positivePayFormat === 'CUSTOM_CSV' && !csvMappingSchema.safeParse(v.positivePayMapping).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['positivePayMapping'], message: 'Set up the custom CSV columns.' });
  }
  if (v.positivePayFormat === 'CUSTOM_FIXED' && !fixedMappingSchema.safeParse(v.positivePayMapping).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['positivePayMapping'], message: 'Set up the custom fixed-width fields.' });
  }
});
export type StockSettingsBody = z.infer<typeof stockSettingsSchema>;

export const micrSchema = z.object({
  bankAccountId: uuid,
  routing: z.string().trim().regex(/^\d{9}$/, 'The routing number is 9 digits'),
  account: z.string().trim().regex(/^[\d\s-]{4,24}$/, 'The account number is 4 to 17 digits'),
});

export const sequenceSchema = z.object({
  bankAccountId: uuid,
  nextNumber: z.number().int().min(1).max(99_999_999),
  reason: z.string().trim().min(3, 'Say why the number is changing').max(500),
});

export const positivePaySchema = z.object({
  bankAccountId: uuid,
  mode: z.enum(['SINCE_LAST', 'RANGE']),
  from: isoDate.nullable().optional(),
  through: isoDate.nullable().optional(),
  preview: z.boolean().optional(),
});

// ── query strings ───────────────────────────────────────────────────────────
export const checkAccountsQuery = z.object({ location_id: uuid.optional() });
export const bankAccountQuery = z.object({ bank_account_id: uuid });
export const registerQuery = z.object({
  bank_account_id: uuid,
  filter: z.enum(['all', 'outstanding', 'cleared', 'void', 'spoiled', 'stale']).optional(),
  q: z.string().max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(['number', 'date', 'amount', 'payee']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  page_size: z.coerce.number().int().min(1).max(500).optional(),
  format: z.enum(['json', 'csv']).optional(),
});
export const clearChecksSchema = z.object({ bankAccountId: uuid.optional() });
