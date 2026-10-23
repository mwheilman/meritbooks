import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/invoices/create-invoice', () => ({ createInvoice: vi.fn() }));
vi.mock('@/lib/db/scoped-writer', () => ({ scopedWriter: vi.fn() }));

const { bpsOf, computeLateFee, customerEligible, DEFAULT_LATE_FEE_POLICY, isFinanceChargeInvoice, lateFeeApprovalBlock, lateFeePolicyInputSchema, resolveLateFeePolicy } = await import('./late-fees');
type LateFeeInvoiceState = import('./late-fees').LateFeeInvoiceState;
type LateFeePolicy = typeof DEFAULT_LATE_FEE_POLICY;
type Facts = Parameters<typeof computeLateFee>[1];

const PCT: LateFeePolicy = { ...DEFAULT_LATE_FEE_POLICY, enabled: true, method: 'PERCENT_MONTHLY', rateBps: 150, graceDays: 10, incomeAccountId: 'acct' };
const facts = (over: Partial<Facts> = {}): Facts => ({
  customerId: 'c1',
  balanceCents: 100_000,
  daysPastDue: 20,
  disputed: false,
  isFinanceCharge: false,
  assessedToDateCents: 0,
  assessedPeriods: new Set(),
  ...over,
});

describe('late-fee math', () => {
  it('percent per month, rounded half-up in integer cents', () => {
    expect(bpsOf(100_000, 150)).toBe(1_500);
    expect(bpsOf(33_333, 150)).toBe(500); // 499.995 → 500
    expect(bpsOf(33_300, 150)).toBe(500); // 499.5 → 500
    expect(bpsOf(33_299, 150)).toBe(499); // 499.485 → 499
    expect(computeLateFee(PCT, facts(), '2026-10-23')).toEqual({ fee: true, periodKey: '2026-10', baseCents: 100_000, feeCents: 1_500, capped: false });
  });

  it('flat fee, min and max per assessment', () => {
    const flat = { ...PCT, method: 'FLAT' as const, flatFeeCents: 2_500 };
    expect(computeLateFee(flat, facts(), '2026-10-23')).toMatchObject({ fee: true, feeCents: 2_500 });
    expect(computeLateFee({ ...PCT, minFeeCents: 2_000 }, facts(), '2026-10-23')).toMatchObject({ feeCents: 2_000 });
    expect(computeLateFee({ ...PCT, maxFeeCents: 1_000 }, facts(), '2026-10-23')).toMatchObject({ feeCents: 1_000, capped: true });
  });

  it('grace days: not until the grace period has passed', () => {
    expect(computeLateFee(PCT, facts({ daysPastDue: 10 }), '2026-10-23')).toEqual({ fee: false, reason: 'in_grace' });
    expect(computeLateFee(PCT, facts({ daysPastDue: 11 }), '2026-10-23')).toMatchObject({ fee: true });
  });

  it('once per period (monthly) — never twice in the same month; ONCE means once ever', () => {
    expect(computeLateFee(PCT, facts({ assessedPeriods: new Set(['2026-10']) }), '2026-10-23')).toEqual({ fee: false, reason: 'already_assessed' });
    expect(computeLateFee(PCT, facts({ assessedPeriods: new Set(['2026-09']) }), '2026-10-23')).toMatchObject({ fee: true, periodKey: '2026-10' });
    const once = { ...PCT, frequency: 'ONCE' as const };
    expect(computeLateFee(once, facts(), '2026-10-23')).toMatchObject({ fee: true, periodKey: 'ONCE' });
    expect(computeLateFee(once, facts({ assessedPeriods: new Set(['2026-09']) }), '2026-10-23')).toEqual({ fee: false, reason: 'already_assessed' });
  });

  it('never compounds: the base is the original balance, fees and finance-charge invoices are never assessed', () => {
    // Prior fees do not change the base (they live on separate finance-charge invoices).
    expect(computeLateFee(PCT, facts({ assessedToDateCents: 1_500, assessedPeriods: new Set(['2026-09']) }), '2026-10-23')).toMatchObject({ baseCents: 100_000, feeCents: 1_500 });
    expect(computeLateFee(PCT, facts({ isFinanceCharge: true }), '2026-10-23')).toEqual({ fee: false, reason: 'not_eligible' });
    expect(isFinanceChargeInvoice({ invoice_type: 'Finance charge' })).toBe(true);
    expect(isFinanceChargeInvoice({ source_ref: 'late-fees:abc' })).toBe(true);
    expect(isFinanceChargeInvoice({ invoice_type: null, source_ref: 'recurring:x' })).toBe(false);
  });

  it('lifetime cap per invoice', () => {
    const capped = { ...PCT, maxTotalPerInvoiceCents: 2_000 };
    expect(computeLateFee(capped, facts({ assessedToDateCents: 1_500, assessedPeriods: new Set(['2026-09']) }), '2026-10-23')).toMatchObject({ feeCents: 500, capped: true });
    expect(computeLateFee(capped, facts({ assessedToDateCents: 2_000, assessedPeriods: new Set(['2026-09']) }), '2026-10-23')).toEqual({ fee: false, reason: 'cap_reached' });
  });

  it('disputed, below-minimum, off, and customer filters', () => {
    expect(computeLateFee(PCT, facts({ disputed: true }), '2026-10-23')).toEqual({ fee: false, reason: 'not_eligible' });
    expect(computeLateFee({ ...PCT, minBalanceCents: 200_000 }, facts(), '2026-10-23')).toEqual({ fee: false, reason: 'below_minimum' });
    expect(computeLateFee({ ...PCT, enabled: false }, facts(), '2026-10-23')).toEqual({ fee: false, reason: 'disabled' });
    expect(customerEligible({ applyTo: 'INCLUDE', customerIds: ['c1'] }, 'c1')).toBe(true);
    expect(customerEligible({ applyTo: 'INCLUDE', customerIds: ['c1'] }, 'c2')).toBe(false);
    expect(customerEligible({ applyTo: 'EXCLUDE', customerIds: ['c1'] }, 'c1')).toBe(false);
    expect(customerEligible({ applyTo: 'EXCLUDE', customerIds: ['c1'] }, null)).toBe(true);
  });

  it('company policy overrides the tenant default', () => {
    const base = { method: 'PERCENT_MONTHLY', flat_fee_cents: 0, rate_bps: 150, grace_days: 0, frequency: 'MONTHLY', min_fee_cents: 0, max_fee_cents: null, max_total_per_invoice_cents: null, min_balance_cents: 0, apply_to: 'ALL', customer_ids: [], income_account_id: null };
    const rows = [{ ...base, location_id: null, enabled: true }, { ...base, location_id: 'b', enabled: true, rate_bps: 200 }];
    expect(resolveLateFeePolicy(rows, 'a')).toMatchObject({ source: 'tenant', rateBps: 150 });
    expect(resolveLateFeePolicy(rows, 'b')).toMatchObject({ source: 'company', rateBps: 200 });
    expect(resolveLateFeePolicy([], 'a')).toMatchObject({ source: 'default', enabled: false });
  });

  it('policy validation', () => {
    const ok = { enabled: true, method: 'PERCENT_MONTHLY', rate_bps: 150, income_account_id: '11111111-1111-4111-8111-111111111111' };
    expect(lateFeePolicyInputSchema.safeParse(ok).success).toBe(true);
    expect(lateFeePolicyInputSchema.safeParse({ ...ok, rate_bps: 1500 }).success).toBe(false); // > 10%/month
    expect(lateFeePolicyInputSchema.safeParse({ ...ok, income_account_id: null }).success).toBe(false);
    expect(lateFeePolicyInputSchema.safeParse({ ...ok, method: 'FLAT', flat_fee_cents: 0 }).success).toBe(false);
    expect(lateFeePolicyInputSchema.safeParse({ ...ok, apply_to: 'INCLUDE', customer_ids: [] }).success).toBe(false);
  });
});

describe('lateFeeApprovalBlock — re-check the invoice at approval (security review LOW)', () => {
  const inv = (over: Partial<LateFeeInvoiceState> = {}): LateFeeInvoiceState => ({
    id: 'i1', invoice_number: 'INV-1', status: 'SENT', balance_cents: 5000, disputed_at: null, ...over,
  });
  it('an open overdue invoice can be charged', () => {
    expect(lateFeeApprovalBlock(inv())).toBeNull();
  });
  it('disputed, paid, voided, written off, credited, draft or gone → skipped', () => {
    expect(lateFeeApprovalBlock(inv({ disputed_at: '2026-10-01T00:00:00Z' }))).toMatch(/disputed/);
    expect(lateFeeApprovalBlock(inv({ status: 'PAID', balance_cents: 0 }))).toMatch(/paid/);
    expect(lateFeeApprovalBlock(inv({ balance_cents: 0 }))).toMatch(/paid/);
    expect(lateFeeApprovalBlock(inv({ status: 'VOIDED' }))).toMatch(/voided/);
    expect(lateFeeApprovalBlock(inv({ status: 'WRITTEN_OFF' }))).toMatch(/written off/);
    expect(lateFeeApprovalBlock(inv({ status: 'CREDITED' }))).toMatch(/credited/);
    expect(lateFeeApprovalBlock(inv({ status: 'DRAFT' }))).toMatch(/draft/);
    expect(lateFeeApprovalBlock(undefined)).toMatch(/no longer exists/);
  });
});
