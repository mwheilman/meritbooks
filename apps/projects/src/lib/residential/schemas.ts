/** Zod inputs of the residential routes. Pure. Amounts are integer cents; rates are fractions. */
import { z } from 'zod';

export const Uuid = z.string().uuid();
export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-31.');
export const Cents = z.number().int().min(0).max(1e13);
export const SignedCents = z.number().int().min(-1e13).max(1e13);
export const Pct = z.number().min(0).max(10);
export const Fraction = z.number().min(0).max(1);
export const QtyN = z.number().min(0).max(1e9);
const T = (max: number) => z.string().trim().max(max);
const Need = (max: number, msg: string) => z.string().trim().min(1, msg).max(max);

export const ContractTypeZ = z.enum(['FIXED_PRICE', 'COST_PLUS_PCT', 'COST_PLUS_FEE', 'COST_PLUS_GMP', 'TIME_MATERIALS', 'DESIGN_AGREEMENT', 'PURCHASE_AGREEMENT']);
export const TaxFormZ = z.enum(['LUMP_SUM_IMPROVEMENT', 'RETAIL_PLUS_INSTALL', 'EXEMPT']);
export const TaxCategoryZ = z.enum(['MATERIAL', 'LABOR', 'SUBCONTRACT', 'DESIGN_FEE', 'EQUIPMENT', 'PERMIT_FEE', 'OTHER']);
export const MethodZ = z.enum(['IN_PERSON', 'PORTAL', 'EMAIL', 'PHONE', 'E_SIGNATURE']);
export const CostTypeZ = z.enum(['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER']);

export const PaymentRowZ = z.object({
  label: Need(120, 'Name the payment'),
  kind: z.enum(['DEPOSIT', 'MILESTONE', 'FINAL']),
  pct: Fraction.nullish(),
  amountCents: Cents.nullish(),
  triggerRef: z.string().regex(/^[a-z0-9_]{1,48}$/).nullish(),
  requiresPhoto: z.boolean().optional(),
  requiresChecklist: z.boolean().optional(),
});

export const ProposalAttrsZ = z.object({
  contractType: ContractTypeZ.optional(),
  feePct: Fraction.nullish(),
  feeCents: Cents.nullish(),
  gmpCents: Cents.nullish(),
  taxForm: TaxFormZ.optional(),
  taxRate: z.number().min(0).max(0.5).optional(),
  stateCode: z.string().regex(/^[A-Z]{2}$/).nullish(),
  scopeNarrative: T(20000).nullish(),
  inclusions: z.array(T(300)).max(60).optional(),
  exclusions: z.array(T(300)).max(60).optional(),
  terms: T(20000).nullish(),
  depositPct: Fraction.nullish(),
  depositCents: Cents.nullish(),
  depositRefundable: z.boolean().optional(),
  creditToBuild: z.boolean().optional(),
  scheduleTemplateKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).nullish(),
  plannedStart: Day.nullish(),
  validUntil: Day.nullish(),
  contingencyPct: z.number().min(0).max(0.5).nullish(),
});
export type ProposalAttrs = z.infer<typeof ProposalAttrsZ>;

/** camelCase body → the jsonb pm.res_create_proposal reads. */
export function attrsToDb(a: ProposalAttrs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Record<string, string> = {
    contractType: 'contract_type', feePct: 'fee_pct', feeCents: 'fee_cents', gmpCents: 'gmp_cents', taxForm: 'tax_contract_form', taxRate: 'tax_rate',
    stateCode: 'state_code', scopeNarrative: 'scope_narrative', inclusions: 'inclusions', exclusions: 'exclusions', terms: 'terms', depositPct: 'deposit_pct',
    depositCents: 'deposit_cents', depositRefundable: 'deposit_refundable', creditToBuild: 'credit_to_build', scheduleTemplateKey: 'schedule_template_key',
    plannedStart: 'planned_start', validUntil: 'valid_until', contingencyPct: 'contingency_pct',
  };
  for (const [k, v] of Object.entries(a)) if (v !== undefined && map[k]) out[map[k]!] = v;
  return out;
}

export const NewProposalZ = z.object({
  companyId: Uuid.nullish(),
  leadId: Uuid.nullish(),
  jobId: Uuid.nullish(),
  title: T(200).nullish(),
  jobTypeKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).nullish(),
  attrs: ProposalAttrsZ.default({}),
}).refine((b) => !!b.leadId !== !!b.jobId, 'Start from a lead or from a job.');

export const LineZ = z.object({
  optionId: Uuid.nullish(),
  catalogItemId: Uuid.nullish(),
  costCodeId: Uuid.nullish(),
  costType: CostTypeZ.optional(),
  room: T(80).nullish(),
  description: T(500).optional(),
  qty: QtyN.optional(),
  uom: T(12).optional(),
  wastePct: z.number().min(0).max(2).optional(),
  unitCostCents: Cents.optional(),
  markupPct: Pct.nullish(),
  marginPct: z.number().min(0).max(0.99).nullish(),
  unitPriceCents: Cents.nullish(),
  laborRateCardId: Uuid.nullish(),
  laborHours: QtyN.nullish(),
  isAllowance: z.boolean().optional(),
  allowanceCategory: T(80).nullish(),
  selectionTitles: z.array(Need(200, 'Name the selection')).max(20).optional(),
  isContingency: z.boolean().optional(),
  taxCategory: TaxCategoryZ.optional(),
  clientVisible: z.boolean().optional(),
  sort: z.number().int().min(0).max(100000).optional(),
});

export function lineToDb(l: z.infer<typeof LineZ>): Record<string, unknown> {
  const m: Record<string, string> = {
    optionId: 'option_id', catalogItemId: 'catalog_item_id', costCodeId: 'cost_code_id', costType: 'cost_type', room: 'room', description: 'description',
    qty: 'qty', uom: 'uom', wastePct: 'waste_pct', unitCostCents: 'unit_cost_cents', markupPct: 'markup_pct', marginPct: 'margin_pct',
    unitPriceCents: 'unit_price_cents', laborRateCardId: 'labor_rate_card_id', laborHours: 'labor_hours', isAllowance: 'is_allowance',
    allowanceCategory: 'allowance_category', selectionTitles: 'selection_titles', isContingency: 'is_contingency', taxCategory: 'tax_category',
    clientVisible: 'client_visible', sort: 'sort',
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(l)) if (v !== undefined && m[k]) out[m[k]!] = v;
  return out;
}

export const OptionZ = z.object({
  kind: z.enum(['ALTERNATE', 'ADD_ON']),
  groupKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Lower-case letters, digits, - and _').nullish(),
  tier: z.enum(['GOOD', 'BETTER', 'BEST']).nullish(),
  label: Need(120, 'Name the option'),
  description: T(4000).nullish(),
  imageUrl: z.string().url().startsWith('http').nullish(),
  sort: z.number().int().min(0).max(1000).optional(),
});

export const CoLineZ = z.object({
  catalogItemId: Uuid.nullish(),
  costCodeId: Uuid.nullish(),
  description: Need(500, 'Describe the line'),
  qty: QtyN.default(1),
  uom: T(12).optional(),
  unitCostCents: Cents.optional(),
  markupPct: Pct.nullish(),
  unitPriceCents: Cents.nullish(),
});

export const coLineToDb = (l: z.infer<typeof CoLineZ>) => ({
  catalog_item_id: l.catalogItemId ?? null, cost_code_id: l.costCodeId ?? null, description: l.description, qty: l.qty, uom: l.uom ?? null,
  unit_cost_cents: l.unitCostCents ?? null, markup_pct: l.markupPct ?? null, unit_price_cents: l.unitPriceCents ?? null,
});

export const Text = T;
export const Required = Need;
