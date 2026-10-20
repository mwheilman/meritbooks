/**
 * Zod schemas for /api/dealer/** (FPB-dealer-pack, slice D1). Every body/query carries
 * `locationId` (the client); org is never taken from the request. Money is integer cents,
 * rates integer basis points, dates ISO YYYY-MM-DD. Contracts: docs/dealer-pack-api.md.
 */

import { z } from 'zod';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const cents = z.number().int().min(0).max(1_000_000_000_000);
const positiveCents = z.number().int().positive().max(1_000_000_000_000);
const bps = z.number().int().min(0).max(100_000);
const text = (max = 500) => z.string().trim().min(1).max(max);
const optText = (max = 500) => z.string().trim().max(max).nullable().optional();
const optUuid = uuid.nullable().optional();
const optDate = isoDate.nullable().optional();

const DEPT_ROLE = z.enum(['WG_NEW', 'WG_USED', 'PARTS', 'SERVICE', 'RENTAL', 'ADMIN']);
const ROLE_KEY = z.enum([
  'WHOLE_GOODS_INVENTORY', 'USED_WHOLE_GOODS_INVENTORY', 'RENTAL_INVENTORY', 'FLOOR_PLAN_PAYABLE',
  'FLOOR_PLAN_INTEREST_ACCRUED', 'FLOOR_PLAN_INTEREST', 'FLOOR_PLAN_FEES', 'WHOLE_GOODS_SALES', 'WHOLE_GOODS_COGS',
  'USED_GOODS_SALES', 'USED_GOODS_COGS', 'TRADE_IN_OVER_ALLOWANCE', 'TRADE_LIEN_PAYOFF', 'SETUP_LABOR_CAPITALIZED',
  'INVENTORY_WRITEDOWN', 'WARRANTY_RECEIVABLE', 'WARRANTY_LABOR_SALES', 'WARRANTY_PARTS_SALES',
  'WARRANTY_POLICY_EXPENSE', 'OEM_INCENTIVE_RECEIVABLE', 'CO_OP_ADVERTISING_RECOVERY',
  'AR_CONTROL', 'AP_CONTROL', 'OPERATING_BANK', 'CUSTOMER_DEPOSITS', 'INVENTORY_ASSET', 'INVENTORY_COGS',
  'INTEREST_EXPENSE', 'ACCRUED_EXPENSES', 'SALES_TAX_PAYABLE',
]);

export const locationOnly = z.object({ locationId: uuid });
export const locationAsOf = z.object({ locationId: uuid, asOf: isoDate.optional() });
export const byId = z.object({ locationId: uuid, id: uuid });

/** Generic list query (filters are allow-listed per list in lib/dealer/service/lists.ts). */
export const listQuery = z
  .object({
    locationId: uuid,
    page: z.string().optional(),
    per_page: z.string().optional(),
    sort: z.string().max(64).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    q: z.string().max(100).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .catchall(z.string().max(500));

// ── settings ──────────────────────────────────────────────────────────────────
export const settingsPatch = z.object({
  locationId: uuid,
  dms_system: optText(100),
  trade_valuation_policy: z.enum(['LOWER_OF_ACV_AND_ALLOWANCE', 'ACV', 'ALLOWANCE']).optional(),
  warranty_recognition: z.enum(['ON_RO_CLOSE', 'ON_SUBMIT']).optional(),
  warranty_relieve_parts_inventory: z.boolean().optional(),
  capitalize_setup_labor: z.boolean().optional(),
  cost_reduction_in_stock: z.enum(['REDUCE_UNIT_COST', 'REDUCE_COGS']).optional(),
  oem_settlement_default: z.enum(['STATEMENT_CREDIT', 'CASH']).optional(),
  sot_grace_days: z.number().int().min(0).max(30).optional(),
  aging_buckets: z.array(z.number().int().positive().max(3650)).min(1).max(8).optional(),
  term_warning_days: z.number().int().min(0).max(3650).optional(),
  interest_tolerance_cents: cents.optional(),
  interest_tolerance_bps: z.number().int().min(0).max(10_000).optional(),
  statement_tolerance_cents: cents.optional(),
  auto_match_min_confidence_bps: z.number().int().min(0).max(10_000).optional(),
  curtailment_warn_days: z.number().int().min(0).max(365).optional(),
  warranty_deadline_warn_days: z.number().int().min(0).max(365).optional(),
  warranty_submitted_aging_days: z.number().int().min(0).max(3650).optional(),
  incentive_deadline_warn_days: z.number().int().min(0).max(365).optional(),
  incentive_submitted_aging_days: z.number().int().min(0).max(3650).optional(),
  lien_unpaid_days: z.number().int().min(0).max(365).optional(),
  over_allowance_warn_bps: z.number().int().min(0).max(10_000).optional(),
  line_utilization_warn_bps: z.number().int().min(0).max(10_000).optional(),
  trade_acv_approval_threshold_cents: cents.optional(),
});

export const roleMapBody = z.object({
  locationId: uuid,
  mappings: z.array(z.object({ roleKey: ROLE_KEY, accountId: uuid.nullable() })).min(1).max(40),
});

export const deptMapBody = z.object({
  locationId: uuid,
  mappings: z.array(z.object({ deptRole: DEPT_ROLE, departmentId: uuid.nullable() })).min(1).max(6),
});

export const enableBody = z.object({ locationId: uuid, enabled: z.boolean() });

// ── lines + programs ──────────────────────────────────────────────────────────
const lineFields = {
  lenderVendorId: uuid,
  name: text(200),
  creditLimitCents: cents,
  liabilityAccountId: optUuid,
  interestDueDay: z.number().int().min(1).max(31).nullable().optional(),
  scheduledPaymentDay: z.number().int().min(1).max(31).nullable().optional(),
  statementDay: z.number().int().min(1).max(31).nullable().optional(),
  sauCodes: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
  debtInstrumentId: optUuid,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CREDIT_HOLD', 'CLOSED']).optional(),
  notes: optText(2000),
};
export const lineCreate = z.object({ locationId: uuid, ...lineFields });
export const lineUpdate = z.object({ locationId: uuid, id: uuid, ...lineFields }).partial({
  lenderVendorId: true, name: true, creditLimitCents: true,
});

const curtailmentRule = z.union([
  z.object({ after_days: z.number().int().positive(), pct_bps: z.number().int().min(1).max(10_000) }).strict(),
  z.object({ after_days: z.number().int().positive(), amount_cents: positiveCents }).strict(),
]);
const programFields = {
  lineId: uuid,
  oemVendorId: optUuid,
  name: text(200),
  freeFloorDays: z.number().int().min(0).max(3650),
  rateType: z.enum(['FIXED', 'INDEX_PLUS']),
  rateBps: bps,
  indexName: optText(100),
  indexRateBps: bps.nullable().optional(),
  spreadBps: z.number().int().min(-10_000).max(100_000).nullable().optional(),
  sauPenaltyRateBps: bps.nullable().optional(),
  dayCount: z.enum(['ACT_365', 'ACT_360']),
  payoffTerms: z.enum(['PAY_AS_SOLD', 'DAYS_AFTER_SALE']),
  payoffDays: z.number().int().min(0).max(365),
  maxTermDays: z.number().int().positive().max(7300).nullable().optional(),
  curtailDemos: z.boolean().optional(),
  curtailmentSchedule: z.array(curtailmentRule).max(24),
  effectiveFrom: isoDate.optional(),
  effectiveTo: optDate,
  status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']).optional(),
};
export const programCreate = z.object({ locationId: uuid, ...programFields });
export const programUpdate = z.object({ locationId: uuid, id: uuid, ...programFields }).partial({
  lineId: true, name: true, freeFloorDays: true, rateType: true, rateBps: true, dayCount: true, payoffTerms: true,
  payoffDays: true, curtailmentSchedule: true,
});

// ── units ─────────────────────────────────────────────────────────────────────
const unitFields = {
  serialNumber: text(100),
  vinHin: optText(100),
  stockNumber: optText(100),
  makeVendorId: optUuid,
  model: optText(200),
  modelYear: z.number().int().min(1900).max(2200).nullable().optional(),
  itemId: optUuid,
  description: optText(1000),
  condition: z.enum(['NEW', 'USED', 'DEMO', 'RENTAL']),
  isConsignment: z.boolean().optional(),
  consignorVendorId: optUuid,
  status: z.enum(['ON_ORDER', 'IN_TRANSIT', 'IN_STOCK']).optional(),
  receivedDate: optDate,
  listPriceCents: cents.nullable().optional(),
  warrantyRegisteredDate: optDate,
  source: z.enum(['DMS', 'LENDER', 'MANUAL', 'OPENING']).optional(),
  externalRef: optText(200),
  importBatchId: optUuid,
  notes: optText(2000),
};
export const unitCreate = z.object({ locationId: uuid, ...unitFields });
export const unitUpdate = z.object({
  locationId: uuid,
  id: uuid,
  serialNumber: text(100).optional(),
  makeVendorId: optUuid,
  vinHin: optText(100),
  stockNumber: optText(100),
  model: optText(200),
  modelYear: z.number().int().min(1900).max(2200).nullable().optional(),
  itemId: optUuid,
  description: optText(1000),
  receivedDate: optDate,
  listPriceCents: cents.nullable().optional(),
  notes: optText(2000),
});

export const unitCostAdd = z
  .object({
    locationId: uuid,
    unitId: uuid,
    costType: z.enum(['BASE_INVOICE', 'FREIGHT', 'SETUP_PDI', 'ACCESSORY', 'RECON', 'OTHER']),
    sourceType: z.enum(['BILL_LINE', 'INTERNAL_RO', 'JE']),
    billLineId: optUuid,
    laborCents: cents.optional(),
    partsCents: cents.optional(),
    offset: z.enum(['AP_CONTROL', 'OPERATING_BANK', 'INVENTORY_ASSET', 'SETUP_LABOR_CAPITALIZED']).optional(),
    amountCents: positiveCents.optional(),
    sourceRef: optText(200),
    costDate: isoDate,
    memo: optText(500),
    post: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.sourceType === 'BILL_LINE' && !v.billLineId) ctx.addIssue({ code: 'custom', path: ['billLineId'], message: 'Required for a bill line' });
    if (v.sourceType === 'JE' && (!v.offset || !v.amountCents)) ctx.addIssue({ code: 'custom', path: ['offset'], message: 'offset and amountCents are required' });
    if (v.sourceType === 'INTERNAL_RO' && !v.laborCents && !v.partsCents) ctx.addIssue({ code: 'custom', path: ['laborCents'], message: 'Give labor and/or parts cost' });
  });
export const unitCostPost = z.object({ locationId: uuid, costId: uuid, entryDate: isoDate });
export const unitCostVoid = z.object({ locationId: uuid, costId: uuid });

export const unitAction = z.object({
  locationId: uuid,
  unitId: uuid,
  action: z.discriminatedUnion('action', [
    z.object({ action: z.literal('MARK_DEMO') }),
    z.object({ action: z.literal('UNMARK_DEMO') }),
    z.object({ action: z.literal('MOVE_TO_RENTAL'), date: isoDate }),
    z.object({ action: z.literal('WRITE_DOWN'), date: isoDate, amountCents: positiveCents, reason: text(500) }),
    z.object({ action: z.literal('RETURN_TO_OEM'), date: isoDate, lenderCreditCents: cents, reason: text(500) }),
    z.object({ action: z.literal('RECORD_WARRANTY_REGISTRATION'), date: isoDate }),
    z.object({ action: z.literal('MARK_DELIVERED') }),
    z.object({ action: z.literal('VOID'), reason: text(500) }),
  ]),
});

// ── flooring + floor-plan money events ────────────────────────────────────────
export const floorBody = z
  .object({
    locationId: uuid,
    lineId: uuid,
    programId: optUuid,
    collateralType: z.enum(['WHOLE_GOOD', 'OPEN_ACCOUNT', 'OTHER']),
    lenderInvoiceNumber: text(100),
    flooredDate: isoDate,
    principalCents: positiveCents,
    description: optText(500),
    scheduledDueDate: optDate,
    unitId: optUuid,
    unit: z.object(unitFields).optional(),
    importBatchId: optUuid,
    opening: z.object({ interestAccruedThrough: optDate }).nullable().optional(),
    dmsInvoiceCostCents: cents.nullable().optional(),
    /** Post immediately (needs journal_entries:post). */
    postNow: z.boolean().optional(),
    /** Importer path: the tenant's DEALER_FLOORING autonomy dial decides. */
    viaImport: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.collateralType === 'WHOLE_GOOD' && !v.unitId && !v.unit) ctx.addIssue({ code: 'custom', path: ['unit'], message: 'A whole-good note needs unitId or unit' });
    if (v.collateralType !== 'WHOLE_GOOD' && (v.unitId || v.unit)) ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Only a whole-good note carries a unit' });
  });
export const txnRef = z.object({ locationId: uuid, txnId: uuid });
export const txnVoid = z.object({ locationId: uuid, txnId: uuid, reason: text(500) });

export const curtailmentPay = z
  .object({
    locationId: uuid,
    curtailmentId: optUuid,
    noteId: optUuid,
    amountCents: positiveCents.nullable().optional(),
    paidDate: isoDate,
    bankTransactionId: optUuid,
  })
  .refine((v) => !!v.curtailmentId || (!!v.noteId && !!v.amountCents), { message: 'Give curtailmentId, or noteId + amountCents' });
export const curtailmentWaive = z.object({ locationId: uuid, curtailmentId: uuid, reason: text(500) });

export const payoffPropose = z.object({ locationId: uuid, noteId: uuid, date: isoDate });
export const payoffRelease = z.object({ locationId: uuid, txnId: uuid, paidDate: isoDate, bankTransactionId: optUuid, paymentId: optUuid });

export const interestAccrue = z.object({ locationId: uuid, periodEnd: isoDate, post: z.boolean().optional() });
export const interestBilled = z.object({
  locationId: uuid,
  lineId: uuid,
  billedCents: positiveCents,
  billDate: isoDate,
  accrualClearedCents: cents.nullable().optional(),
  bankTransactionId: optUuid,
  acceptVariance: z.boolean().optional(),
  reference: optText(200),
});
export const feeBody = z.object({
  locationId: uuid,
  lineId: uuid,
  noteId: optUuid,
  feeCents: positiveCents,
  feeDate: isoDate,
  memo: text(300),
  bankTransactionId: optUuid,
});

// ── sales + trade-ins ─────────────────────────────────────────────────────────
export const saleCreate = z.object({
  locationId: uuid,
  unitId: uuid,
  customerId: optUuid,
  saleDate: isoDate,
  salePriceCents: cents,
  taxCents: cents.optional(),
  depositId: optUuid,
  depositAppliedCents: cents.optional(),
  retailRebateCents: cents.optional(),
  retailRebateProgramId: optUuid,
  invoiceId: optUuid,
  trade: z
    .object({
      serialNumber: text(100),
      makeVendorId: optUuid,
      model: optText(200),
      modelYear: z.number().int().min(1900).max(2200).nullable().optional(),
      allowanceCents: cents,
      acvCents: cents,
      lienPayoffCents: cents.optional(),
      lienholderVendorId: optUuid,
    })
    .nullable()
    .optional(),
  salesperson: optText(200),
  retailFinanceVendorId: optUuid,
  source: z.enum(['BOOKS', 'DMS']).optional(),
  externalDealRef: optText(200),
  importBatchId: optUuid,
});
export const saleRef = z.object({ locationId: uuid, saleId: uuid });
export const saleVoid = z.object({ locationId: uuid, saleId: uuid, reason: text(500) });
export const tradeRef = z.object({ locationId: uuid, tradeId: uuid });
export const tradeLien = z.discriminatedUnion('action', [
  z.object({ locationId: uuid, tradeId: uuid, action: z.literal('propose') }),
  z.object({ locationId: uuid, tradeId: uuid, action: z.literal('release'), paidDate: isoDate }),
]);

// ── warranty ──────────────────────────────────────────────────────────────────
const warrantyFields = {
  oemVendorId: uuid,
  oemClaimNumber: optText(100),
  dealerClaimRef: optText(100),
  repairOrderRef: optText(100),
  jobId: optUuid,
  unitId: optUuid,
  serialNumber: optText(100),
  customerId: optUuid,
  failureDate: optDate,
  repairDate: optDate,
  filingDeadline: optDate,
  laborHours: z.union([z.number().min(0).max(10_000), z.string().regex(/^\d{1,5}(\.\d{1,2})?$/)]),
  laborRateCents: cents,
  partsCostCents: cents,
  partsMarkupBps: bps,
  subletCents: cents.optional(),
  freightCents: cents.optional(),
  otherCents: cents.optional(),
  importBatchId: optUuid,
};
export const warrantyCreate = z.object({ locationId: uuid, ...warrantyFields });
export const warrantyUpdate = z.object({ locationId: uuid, id: uuid, ...warrantyFields });
export const warrantySubmit = z.object({ locationId: uuid, claimId: uuid, submittedDate: isoDate, oemClaimNumber: optText(100) });
export const warrantyRoClose = z.object({ locationId: uuid, claimId: uuid, roClosedDate: isoDate });
export const claimSettle = z.object({
  locationId: uuid,
  claimId: uuid,
  amountCents: positiveCents,
  method: z.enum(['STATEMENT_CREDIT', 'CASH']).optional(),
  date: isoDate,
  oemStatementLineId: optUuid,
  reference: optText(200),
});
export const warrantyResolve = z.object({
  locationId: uuid,
  claimId: uuid,
  resolution: z.discriminatedUnion('action', [
    z.object({ action: z.literal('ACCEPT_SHORT_PAY'), date: isoDate, note: optText(1000) }),
    z.object({ action: z.literal('WRITE_OFF'), date: isoDate, note: optText(1000) }),
    z.object({ action: z.literal('REJECTED_BY_OEM'), date: isoDate, reason: text(1000) }),
    z.object({ action: z.literal('RESUBMIT'), date: isoDate, note: optText(1000) }),
    z.object({ action: z.literal('DEBIT'), date: isoDate, amountCents: positiveCents, note: optText(1000) }),
  ]),
});

// ── OEM programs + incentives ─────────────────────────────────────────────────
const PROGRAM_TYPE = z.enum(['RETAIL_REBATE', 'DEALER_REBATE', 'VOLUME_BONUS', 'HOLDBACK', 'CO_OP', 'SPIFF', 'INTEREST_SUBSIDY', 'FLOOR_PLAN_SUPPORT', 'DEMO_SUPPORT', 'OTHER']);
const TREATMENT = z.enum(['TRANSACTION_PRICE', 'COST_REDUCTION', 'EXPENSE_REIMBURSEMENT', 'PASS_THROUGH']);
const oemProgramFields = {
  oemVendorId: uuid,
  programCode: optText(100),
  name: text(200),
  programType: PROGRAM_TYPE,
  treatment: TREATMENT.optional(),
  paidDirect: z.boolean().optional(),
  startDate: optDate,
  endDate: optDate,
  claimDeadlineDays: z.number().int().min(0).max(3650).nullable().optional(),
  rules: z.record(z.unknown()).optional(),
  sourceDocumentId: optUuid,
};
export const oemProgramCreate = z.object({ locationId: uuid, ...oemProgramFields });
export const oemProgramUpdate = z.object({ locationId: uuid, id: uuid, ...oemProgramFields }).partial({
  oemVendorId: true, name: true, programType: true,
});
export const oemProgramStatus = z.object({ locationId: uuid, id: uuid, status: z.enum(['ACTIVE', 'EXPIRED']) });
export const incentiveAccrue = z.object({
  locationId: uuid,
  programId: uuid,
  unitId: optUuid,
  saleId: optUuid,
  amountCents: positiveCents,
  earnedDate: isoDate,
  claimReference: optText(100),
});
export const incentiveSubmit = z.object({ locationId: uuid, claimId: uuid, submittedDate: isoDate, claimedCents: positiveCents.nullable().optional(), claimReference: optText(100) });
export const incentiveResolve = z.object({
  locationId: uuid,
  claimId: uuid,
  resolution: z.discriminatedUnion('action', [
    z.object({ action: z.literal('WRITE_OFF'), date: isoDate, note: optText(1000) }),
    z.object({ action: z.literal('REJECTED_BY_OEM'), date: isoDate, reason: text(1000) }),
  ]),
});

// ── statements ────────────────────────────────────────────────────────────────
const signedCents = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000);
export const lenderStatementImport = z.object({
  locationId: uuid,
  lineId: uuid,
  kind: z.enum(['STATEMENT', 'AUDIT', 'PAYOFF_QUOTE']),
  statementDate: isoDate,
  documentId: optUuid,
  importBatchId: optUuid,
  footer: z.object({
    principalCents: cents.nullable(),
    interestCents: cents.nullable().optional(),
    feesCents: cents.nullable().optional(),
    lineCount: z.number().int().min(0).nullable().optional(),
  }),
  lines: z
    .array(
      z.object({
        lenderInvoiceNumber: optText(100),
        serialNumber: optText(100),
        model: optText(200),
        originalCents: cents.nullable().optional(),
        currentCents: cents.nullable().optional(),
        interestCents: cents.nullable().optional(),
        feesCents: cents.nullable().optional(),
        lenderCode: optText(20),
        dispositionDate: optDate,
        days: z.number().int().min(0).max(100_000).nullable().optional(),
      }),
    )
    .max(5000),
  notes: optText(2000),
});
export const statementRef = z.object({ locationId: uuid, statementId: uuid });
export const statementLineResolve = z.object({ locationId: uuid, lineId: uuid, resolution: text(1000) });

export const oemStatementImport = z.object({
  locationId: uuid,
  oemVendorId: uuid,
  statementDate: isoDate,
  documentId: optUuid,
  importBatchId: optUuid,
  footerTotalCents: signedCents,
  lines: z
    .array(
      z.object({
        lineType: z.enum(['WARRANTY_CREDIT', 'INCENTIVE_CREDIT', 'DEBIT', 'PARTS_INVOICE', 'OTHER']),
        reference: optText(100),
        serialNumber: optText(100),
        description: optText(500),
        amountCents: signedCents,
      }),
    )
    .max(5000),
});
export const oemLineSettle = z.object({
  locationId: uuid,
  lineId: uuid,
  date: isoDate,
  claimKind: z.enum(['WARRANTY', 'INCENTIVE']).optional(),
  claimId: optUuid,
});
export const oemLineRef = z.object({ locationId: uuid, lineId: uuid });

// ── imports ───────────────────────────────────────────────────────────────────
const FILE_KIND = z.enum(['UNITS', 'DEALS', 'WARRANTY', 'LENDER_STATEMENT', 'LENDER_AUDIT', 'OEM_STATEMENT', 'PROGRAMS', 'OPENING']);
export const importCreate = z.object({
  locationId: uuid,
  sourceSystem: text(100),
  fileKind: FILE_KIND,
  fileName: optText(300),
  documentId: optUuid,
  rowCount: z.number().int().min(0).optional(),
});
export const importUpdate = z.object({
  locationId: uuid,
  id: uuid,
  status: z.enum(['UPLOADED', 'VALIDATED', 'PROPOSED', 'POSTED', 'FAILED']).optional(),
  rowCount: z.number().int().min(0).optional(),
  acceptedCount: z.number().int().min(0).optional(),
  rejectedCount: z.number().int().min(0).optional(),
  errors: z.array(z.unknown()).max(5000).optional(),
});
