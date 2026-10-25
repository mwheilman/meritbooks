/**
 * Residential pure libraries (migration 1119's app side): proposal arithmetic, the screens' state
 * words and moves, the no-account trade page helpers and the route input mapping. The arithmetic
 * is parity-tested against the database in packages/projects-access/test/residential.test.ts;
 * here are the edge cases.
 */
import { describe, expect, it } from 'vitest';
import {
  allowanceDelta, cutoffState, isTaxable, neededBy, pinPaymentSchedule, priceLine, proposalTotals, replanChain, scheduleCoverage, sell,
  type TotalsLine,
} from '@/lib/residential/pricing';
import {
  allowanceDeltaWords, byRoom, houseStage, proposalMoves, scheduleShare, sendBlocker, PROPOSAL_STATUS, PAYMENT_STATUS, EXPOSURE_STATE, TRADE_STATUS, LOT_STATUS,
} from '@/lib/residential/labels';
import { centsFromDollars, esc, page, trustedClientIp } from '@/lib/residential/public-page';
import { NewProposalZ, attrsToDb, coLineToDb, lineToDb, LineZ, CoLineZ, PaymentRowZ } from '@/lib/residential/schemas';

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
const line = (over: Partial<TotalsLine> = {}): TotalsLine => ({ optionId: null, priceCents: 0, costCents: 0, overheadCents: 0, isAllowance: false, isContingency: false, taxCategory: 'MATERIAL', ...over });

describe('residential pricing', () => {
  it('sells by margin or markup, rounding half away from zero once', () => {
    expect(sell(10000, 0.5, null)).toBe(15000);
    expect(sell(10000, null, 0.25)).toBe(13333);
    expect(sell(1, 0.5, null)).toBe(2); // 1.5 → 2
    expect(sell(10000, null, null)).toBe(10000);
  });

  it('labor keeps overhead out of cost and in the price', () => {
    const r = priceLine({ qty: 10, unitCostCents: 0, labor: { costRateCents: 4200, estimatingRateCents: 5460 }, laborHours: 10, markupPct: 0.5 });
    expect(r.costCents).toBe(42000);
    expect(r.overheadCents).toBe(12600);
    expect(r.unitSellCents).toBe(8190);
    expect(r.priceCents).toBe(81900);
  });

  it('material with waste; an explicit unit price wins; an allowance with no cost costs its price', () => {
    expect(priceLine({ qty: 100, wastePct: 0.1, unitCostCents: 350, markupPct: 0.3 })).toMatchObject({ costCents: 38500, priceCents: 50050 });
    expect(priceLine({ qty: 2, unitCostCents: 1000, unitPriceCents: 2500 }).priceCents).toBe(5000);
    expect(priceLine({ qty: 1, unitCostCents: 0, unitPriceCents: 500000, isAllowance: true })).toMatchObject({ costCents: 500000, priceCents: 500000 });
  });

  it('totals: options, allowance, auto contingency on the non-allowance base, cost-plus fee, tax by contract form, capped deposit less the retainer', () => {
    const lines = [line({ priceCents: 100000, costCents: 70000 }), line({ priceCents: 50000, costCents: 50000, isAllowance: true }), line({ optionId: 'o', priceCents: 20000, costCents: 12000, taxCategory: 'LABOR' })];
    const fixed = proposalTotals({ contractType: 'FIXED_PRICE', taxForm: 'RETAIL_PLUS_INSTALL', taxRate: 0.07, contingencyPct: 0.05, depositPct: 0.5, retainerCreditCents: 10000 }, lines,
      { laborTaxable: false, designFeeTaxable: false, depositCapPct: 0.1, depositCapCents: 100000 });
    expect(fixed.basePriceCents).toBe(150000);
    expect(fixed.optionsPriceCents).toBe(20000);
    expect(fixed.allowanceCents).toBe(50000);
    expect(fixed.contingencyCents).toBe(6000); // 5% of 120,000 (base + option, not the allowance)
    expect(fixed.totalCents).toBe(176000);
    expect(fixed.taxCents).toBe(10500); // material + allowance (material) 150,000 × 7%; labor untaxed
    expect(fixed.depositDueCents).toBe(7600); // min(50%, 10% cap = 17,600) − 10,000 retainer
    const cp = proposalTotals({ contractType: 'COST_PLUS_PCT', feePct: 0.15, taxForm: 'LUMP_SUM_IMPROVEMENT', taxRate: 0.06 }, lines);
    expect(cp.feeTotalCents).toBe(19800);
    expect(cp.taxCents).toBe(0);
    expect(cp.useTaxCents).toBe(7200); // on material cost 120,000
    expect(proposalTotals({ contractType: 'FIXED_PRICE', taxForm: 'EXEMPT', taxRate: 0 }, []).marginPct).toBeNull();
  });

  it('taxability follows the contract form and the state', () => {
    expect(isTaxable('MATERIAL', 'LUMP_SUM_IMPROVEMENT', null)).toBe(false);
    expect(isTaxable('LABOR', 'RETAIL_PLUS_INSTALL', { laborTaxable: true, designFeeTaxable: false })).toBe(true);
    expect(isTaxable('DESIGN_FEE', 'RETAIL_PLUS_INSTALL', { laborTaxable: true, designFeeTaxable: false })).toBe(false);
  });

  it('pins a schedule (last row takes the remainder) and measures coverage', () => {
    expect(pinPaymentSchedule(100001, [{ pct: 0.1 }, { pct: 0.3 }, { pct: 0.3 }, {}])).toEqual([10000, 30000, 30000, 30001]);
    expect(pinPaymentSchedule(50000, [{ amountCents: 1000 }, { pct: 0.5 }])).toEqual([1000, 49000]);
    expect(scheduleCoverage(100000, [{ pct: 0.25 }, { amountCents: 25000 }, { pct: 0.5 }])).toBeCloseTo(1);
  });

  it('allowance delta before choosing, shared allowances included', () => {
    expect(allowanceDelta(250000, 200000)).toEqual({ overCents: 50000, underCents: 0, remainingCents: 200000 });
    expect(allowanceDelta(50000, 200000, 180000)).toEqual({ overCents: 30000, underCents: 0, remainingCents: 20000 });
    expect(allowanceDelta(10000, 200000, 250000)).toEqual({ overCents: 10000, underCents: 0, remainingCents: -50000 });
    expect(allowanceDelta(1, null)).toBeNull();
  });

  it('needed-by dates and chain re-planning', () => {
    expect(neededBy('2027-03-15', 21, 3)).toBe('2027-02-19');
    const steps = [{ leadDays: 0, done: true }, { leadDays: 2, done: false }, { leadDays: 10, done: false }];
    expect(replanChain(steps, 0, '2027-03-01')).toEqual(['2027-03-03', '2027-03-13']);
  });

  it('design-center cutoffs: open until passed, then a late fee — or closed for structural', () => {
    expect(cutoffState('PRE_FRAME', 'PRE_DRYWALL', true)).toBe('open');
    expect(cutoffState('PRE_TRIM', 'PRE_DRYWALL', false)).toBe('late_fee');
    expect(cutoffState('PRE_TRIM', 'PRE_DRYWALL', true)).toBe('closed');
    expect(cutoffState('CLOSEOUT', 'ANYTIME', true)).toBe('open');
  });
});

describe('residential labels and moves', () => {
  it('every state has a word and a pip', () => {
    for (const m of [PROPOSAL_STATUS, PAYMENT_STATUS, EXPOSURE_STATE, TRADE_STATUS, LOT_STATUS]) {
      for (const v of Object.values(m)) { expect(v.word.length).toBeGreaterThan(1); expect(v.pip).toBeTruthy(); }
    }
  });

  it('only offers moves the database takes', () => {
    expect(proposalMoves({ status: 'DRAFT', envelope_id: null }, false)).toEqual({ edit: true, send: true, accept: false, sign: false, revise: false, decline: true });
    expect(proposalMoves({ status: 'SENT', envelope_id: 'e' }, true)).toMatchObject({ edit: false, accept: true, sign: false, revise: true });
    expect(proposalMoves({ status: 'ACCEPTED', envelope_id: null }, false)).toEqual({ edit: false, send: false, accept: false, sign: false, revise: false, decline: false });
  });

  it('says why a draft cannot be sent', () => {
    expect(sendBlocker({ lines: [], options: [], schedulePctSum: null })).toMatch(/at least one line/);
    expect(sendBlocker({ lines: [{ cost_code_id: 'c', option_id: null }], options: [{ kind: 'ALTERNATE', group_key: 'tops', is_selected: true }, { kind: 'ALTERNATE', group_key: 'tops', is_selected: true }], schedulePctSum: 1 })).toMatch(/only one option in “tops”/);
    expect(sendBlocker({ lines: [{ cost_code_id: 'c', option_id: null }], options: [], schedulePctSum: 0.9 })).toMatch(/90%/);
    expect(sendBlocker({ lines: [{ cost_code_id: 'c', option_id: null }], options: [], schedulePctSum: null })).toBeNull();
  });

  it('schedule shares, rooms, allowance words, house stage', () => {
    expect(scheduleShare({ kind: 'MILESTONE', pct: 0.25, amount_cents: null }, fmt)).toBe('25%');
    expect(scheduleShare({ kind: 'DEPOSIT', pct: 0.1, amount_cents: 1250 }, fmt)).toBe('$12.50');
    expect(scheduleShare({ kind: 'FINAL', pct: null, amount_cents: null }, fmt)).toBe('Balance');
    expect(byRoom([{ room: 'Kitchen' }, { room: null }, { room: ' Kitchen ' }]).map((r) => [r.room, r.lines.length])).toEqual([['Kitchen', 2], ['General', 1]]);
    expect(allowanceDeltaWords({ over_cents: 18400, under_cents: 0 }, true, fmt)).toEqual({ text: '$184.00 over the allowance', tone: 'neg' });
    expect(allowanceDeltaWords({ over_cents: 0, under_cents: 500 }, true, fmt).tone).toBe('pos');
    expect(allowanceDeltaWords({ over_cents: 18400, under_cents: 0 }, false, fmt).text).toBe('');
    const t = (title: string, status = 'DONE') => ({ title, status, is_summary: false });
    expect(houseStage([])).toBe('PRE_START');
    expect(houseStage([t('Excavation')])).toBe('PRE_FRAME');
    expect(houseStage([t('Framing'), t('Excavation')])).toBe('PRE_DRYWALL');
    expect(houseStage([t('Hang drywall', 'IN_PROGRESS')])).toBe('PRE_TRIM');
    expect(houseStage([t('Install cabinets', 'IN_PROGRESS'), t('Hang drywall')])).toBe('CLOSEOUT');
    expect(houseStage([{ title: 'Framing', status: 'DONE', is_summary: true }])).toBe('PRE_START');
  });
});

describe('the no-account trade page', () => {
  it('escapes everything it interpolates', () => {
    expect(esc('<script>"x"</script>')).not.toMatch(/[<>"]/);
    expect(esc(null)).toBe('');
    const html = page('Bid <b>', '<p>ok</p>');
    expect(html).toContain('<title>Bid &#60;b&#62;</title>');
    expect(html).toContain('noindex');
  });

  it('takes the client address from the platform, never the caller-controlled left of x-forwarded-for', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(trustedClientIp(h({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }))).toBe('203.0.113.7');
    expect(trustedClientIp(h({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4' }))).toBe('198.51.100.4');   // spoofed left hop ignored
    expect(trustedClientIp(h({ 'x-forwarded-for': '6.6.6.6' }), '198.51.100.9')).toBe('198.51.100.9');
    expect(trustedClientIp(h({ 'x-vercel-forwarded-for': 'not an ip<script>' }), null)).toBeNull();
    expect(trustedClientIp(h({}))).toBeNull();
    expect(trustedClientIp(h({ 'x-vercel-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('reads dollars as cents and rejects the rest', () => {
    expect(centsFromDollars('1,250.5')).toBe(125050);
    expect(centsFromDollars('$99')).toBe(9900);
    expect(centsFromDollars('')).toBeNull();
    expect(centsFromDollars('12.345')).toBeUndefined();
    expect(centsFromDollars('-4')).toBeUndefined();
  });
});

describe('residential route inputs', () => {
  it('starts from a lead or a job, not both', () => {
    const lead = '11111111-1111-4111-8111-111111111111';
    expect(NewProposalZ.safeParse({ leadId: lead }).success).toBe(true);
    expect(NewProposalZ.safeParse({ leadId: lead, jobId: lead }).success).toBe(false);
    expect(NewProposalZ.safeParse({}).success).toBe(false);
  });

  it('maps camelCase bodies onto the columns the database reads, dropping unknowns', () => {
    expect(attrsToDb({ contractType: 'COST_PLUS_GMP', feePct: 0.12, taxForm: 'RETAIL_PLUS_INSTALL', inclusions: ['a'] }))
      .toEqual({ contract_type: 'COST_PLUS_GMP', fee_pct: 0.12, tax_contract_form: 'RETAIL_PLUS_INSTALL', inclusions: ['a'] });
    const l = LineZ.parse({ description: 'Tile', qty: 3, isAllowance: true, selectionTitles: ['Backsplash'], unitCostCents: 100 });
    expect(lineToDb(l)).toEqual({ description: 'Tile', qty: 3, is_allowance: true, selection_titles: ['Backsplash'], unit_cost_cents: 100 });
    expect(coLineToDb(CoLineZ.parse({ description: 'Sister joists' }))).toMatchObject({ description: 'Sister joists', qty: 1, unit_price_cents: null });
    expect(LineZ.safeParse({ unitCostCents: 1.5 }).success).toBe(false);
    expect(PaymentRowZ.safeParse({ label: 'Deposit', kind: 'DEPOSIT', pct: 1.5 }).success).toBe(false);
  });
});
