/**
 * Billing preconditions → sentences, billing modes from job-type modules, money error mapping,
 * status words, and roll-ups. Drift checks read the migration so a new token cannot ship unmapped.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModuleKey } from '@meritbooks/industry-packs';
import { PRECONDITION_COPY, parsePreconditionList, preconditionCopy, preconditionFixHref, preconditionsSentence } from '@/lib/pm/money/preconditions';
import { billingModesFor, modeAllowed, wireModeOf } from '@/lib/pm/money/billing-modes';
import { DETAIL_TOKENS, approvalRoleSentence, isKnownMoneyToken, mapMoneyError } from '@/lib/pm/money/errors';
import { billingKindLabel, billingMark, complianceMark, seamSentence, unissuedSentence, worstAlarm } from '@/lib/pm/money/status';
import { billedToDate, billingBand, byFade, canSend, commitmentTotals, estimateTotals, heldToDate, marginFade } from '@/lib/pm/money/summaries';
import { jobTabs } from '@/lib/pm/job-tabs';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';
import type { CommitmentStatusRow, JobFinancialsRow } from '@/lib/pm/money/types';

const MIG = resolve(__dirname, '../../../../packages/supabase/migrations');
const sql1102 = readFileSync(resolve(MIG, '1102_pm_commitments_billing.sql'), 'utf8');
const sql1103 = readFileSync(resolve(MIG, '1103_pm_cost_drain.sql'), 'utf8');
const raised = [...new Set([...`${sql1102}\n${sql1103}`.matchAll(/raise exception '([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!))];

describe('billing preconditions → one plain sentence each', () => {
  const named = [...new Set([...sql1102.matchAll(/'(PRECONDITION_[A-Z0-9_]+)'/g), ...sql1102.matchAll(/raise exception '(PRECONDITION_[A-Z0-9_]+)/g)].map((m) => m[1]!))].filter((c) => c !== 'PRECONDITION_FAILED');

  it('covers every precondition code the migration names or raises', () => {
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((c) => !(c in PRECONDITION_COPY))).toEqual([]);
  });

  it.each(Object.entries(PRECONDITION_COPY))('%s reads as a sentence with no codes', (_code, copy) => {
    expect(copy.sentence).toMatch(/^[A-Z].*\.$/);
    expect(copy.sentence).not.toMatch(/_|PRECONDITION|cents/);
    if (copy.fix) expect(!!copy.fix.tab !== !!copy.fix.href).toBe(true);
  });

  it('parses the PRECONDITION_FAILED list and joins the sentences', () => {
    const codes = parsePreconditionList('PRECONDITION_NO_CUSTOMER,PRECONDITION_OVER_CONTRACT');
    expect(codes).toEqual(['PRECONDITION_NO_CUSTOMER', 'PRECONDITION_OVER_CONTRACT']);
    expect(preconditionsSentence(codes)).toBe('The job has no customer for Merit Books to invoice. Billed to date would pass the revised contract; approve a change order first.');
    expect(preconditionsSentence([])).toBe('Ready to send.');
  });

  it('fixes link to the job tab or the page', () => {
    expect(preconditionFixHref('PRECONDITION_NO_CONTRACT', 'j1')).toBe('/jobs/j1?tab=contract');
    expect(preconditionFixHref('PRECONDITION_COMPLIANCE', 'j1')).toBe('/jobs/j1?tab=commitments');
    expect(preconditionFixHref('PRECONDITION_DRAW', 'j1')).toBe('/draws');
    expect(preconditionFixHref('PRECONDITION_NO_LINES', 'j1')).toBeNull();
  });

  it('an unknown code still gets a sentence', () => {
    expect(preconditionCopy('PRECONDITION_LIEN_RELEASE').sentence).toBe('A billing check (lien release) is not met yet.');
  });
});

describe('billing modes from the job type', () => {
  const mods = (...m: ModuleKey[]) => new Set<ModuleKey>(m);
  it('maps billing_modes to generators, default first', () => {
    expect(billingModesFor({ billingModes: ['PROGRESS_PCT', 'SOV'], defaultBillingMode: 'SOV', modules: mods('billing') }).modes).toEqual(['sov', 'progress', 'retainage']);
    expect(billingModesFor({ billingModes: ['FIXED', 'DEPOSIT'], defaultBillingMode: 'DEPOSIT', modules: mods('billing') })).toEqual({ modes: ['deposit', 'fixed'], initial: 'deposit', draws: false, recurring: false });
  });
  it('retainage release follows the retainage module or a withholding mode; allowances follow the module', () => {
    expect(billingModesFor({ billingModes: ['MILESTONE'], modules: mods('billing') }).modes).toEqual(['milestone']);
    expect(billingModesFor({ billingModes: ['MILESTONE'], modules: mods('billing', 'retainage', 'allowances') }).modes).toEqual(['milestone', 'retainage', 'allowance']);
    expect(billingModesFor({ billingModes: ['DRAW'], modules: mods('lender_draws') })).toMatchObject({ modes: ['retainage'], draws: true });
  });
  it('T&M and recurring', () => {
    expect(billingModesFor({ billingModes: ['TIME_MATERIALS', 'RECURRING'], defaultBillingMode: 'RECURRING', modules: mods() })).toEqual({ modes: ['tm'], initial: 'tm', draws: false, recurring: true });
  });
  it('the route re-check agrees with the UI', () => {
    const i = { billingModes: ['SOV'], modules: mods('billing') };
    expect(modeAllowed(i, 'sov')).toBe(true);
    expect(modeAllowed(i, 'deposit')).toBe(false);
    expect(wireModeOf('sov')).toBe('SOV');
    expect(wireModeOf('retainage')).toBeNull();
  });
  it('job tabs follow the modules: estimate, commitments, billing, job cost', () => {
    const tabs = (m: ModuleKey[]) => jobTabs(new Set(m), { ...DEFAULT_VOCAB }).map((t) => `${t.value}${t.later ? '*' : ''}`);
    expect(tabs([])).toEqual(['overview', 'contract', 'activity']);
    expect(tabs(['estimates', 'budget', 'commitments', 'billing'])).toEqual(['overview', 'estimates', 'budget', 'contract', 'commitments', 'billing', 'job-cost', 'activity']);
    expect(tabs(['retainage'])).toContain('billing');
  });
});

describe('money errors → status and plain words', () => {
  it('maps every token 1102/1103 raise to a sentence (JOB_COST_* stay inside the drain)', () => {
    const unmapped = raised.filter((t) => !t.startsWith('JOB_COST_') && !DETAIL_TOKENS.has(t) && !isKnownMoneyToken(t));
    expect(unmapped).toEqual([]);
  });

  it('separation of duties names what was prepared', () => {
    expect(mapMoneyError({ code: '42501', message: 'PM_SOD_VIOLATION: the preparer of SC-ACM-2026-0001 cannot approve it' }, 'commitment')).toEqual({
      status: 403, body: { error: 'You prepared this commitment, so someone else has to approve it.', code: 'PM_SOD_VIOLATION' },
    });
    expect(mapMoneyError({ code: '42501', message: 'PM_SOD_VIOLATION: the preparer of a billing request cannot approve it' }, 'billing request').body.error).toBe('You prepared this billing request, so someone else has to approve it.');
  });

  it('approval tiers in plain words', () => {
    const m = mapMoneyError({ code: '42501', message: 'PM_APPROVAL_ROLE: approving 2800000000 cents under policy commitment needs role ["owner"]; approver has pm' }, 'commitment');
    expect(m).toEqual({ status: 403, body: { error: 'This amount needs approval by an owner. You are signed in as project manager.', code: 'PM_APPROVAL_ROLE' } });
    expect(approvalRoleSentence('approving 1 cents under policy commitment needs role ["controller","owner"]; approver has (none)')).toBe('This amount needs approval by a controller or owner. Your account has no approval role yet.');
    expect(mapMoneyError({ code: '42501', message: 'PM_APPROVAL_NO_TIER: 999 cents exceeds every tier of approval policy commitment' }).status).toBe(403);
    expect(mapMoneyError({ code: '0A000', message: 'PM_APPROVAL_MULTI_UNSUPPORTED: tier 3 of policy commitment needs 2 approvers' })).toMatchObject({ status: 422, body: { code: 'PM_APPROVAL_MULTI_UNSUPPORTED' } });
  });

  it('PRECONDITION_FAILED becomes the joined sentences with the codes', () => {
    const m = mapMoneyError({ code: 'P0001', message: 'PRECONDITION_FAILED: PRECONDITION_NO_CUSTOMER,PRECONDITION_NONPOSITIVE' }, 'billing request');
    expect(m.status).toBe(422);
    expect(m.body.preconditions).toEqual(['PRECONDITION_NO_CUSTOMER', 'PRECONDITION_NONPOSITIVE']);
    expect(m.body.error).toMatch(/^The job has no customer/);
    expect(mapMoneyError({ code: 'P0001', message: 'PRECONDITION_BOOKS_SEAM_V2: Books does not yet book retainage releases as a reclass (needs books_seam_version >= 2)' }).body.error).toBe(PRECONDITION_COPY.PRECONDITION_BOOKS_SEAM_V2!.sentence);
  });

  it('state and validation tokens keep their status with the money sentence', () => {
    expect(mapMoneyError({ code: '22023', message: 'PM_COMMITMENT_BILLED: SC-1 has 500 cents billed; close it instead' })).toEqual({ status: 422, body: { error: 'Merit Books has bills against this commitment, so it cannot be voided. Close it instead.', code: 'PM_COMMITMENT_BILLED' } });
    expect(mapMoneyError({ code: '42501', message: 'PM_ESTIMATE_LOCKED: estimate lines can change only while the estimate is DRAFT (is SENT)' }).status).toBe(403);
    expect(mapMoneyError({ code: 'P0002', message: 'PM_UNKNOWN_SOV: version x is not on job y' }).status).toBe(404);
    expect(mapMoneyError({ code: '22023', message: 'PM_INVALID: receipt qty must be > 0' }).body.error).toBe('Receipt qty must be > 0.');
    expect(mapMoneyError({ code: '42501', message: 'permission denied for table billing_requests' }).body.error).toBe('You don’t have access to do that.');
  });
});

describe('status words', () => {
  it('billing: draft → waiting on Merit Books → issued / rejected; unissued is honest', () => {
    expect(['DRAFT', 'EMITTED', 'ISSUED', 'REJECTED', 'UNISSUED', 'VOID'].map((s) => billingMark(s as 'DRAFT').word)).toEqual(['Draft', 'Waiting on Merit Books', 'Issued', 'Rejected by Merit Books', 'Approved, not sent', 'Void']);
    expect(billingMark('UNISSUED', 'SAMPLE').word).toBe('Sample, not sent');
    expect(unissuedSentence('STANDALONE')).toMatch(/Merit Books is not on/);
    expect(billingKindLabel({ billing_type: 'PROGRESS', billing_subtype: 'SOV', application_no: 3 })).toBe('Pay application #3');
    expect(billingKindLabel({ billing_type: 'TIME_MATERIALS', billing_subtype: null, application_no: null })).toBe('Time & materials');
  });
  it('compliance: verified past expiry reads expired; 30-day warning', () => {
    expect(complianceMark({ status: 'VERIFIED', expires_on: '2026-10-01', required: true }, '2026-10-20')).toMatchObject({ word: 'Expired', ok: false });
    expect(complianceMark({ status: 'VERIFIED', expires_on: '2026-11-05', required: true }, '2026-10-20')).toMatchObject({ word: 'Expires soon', ok: true, expiringSoon: true });
    expect(complianceMark({ status: 'RECEIVED', expires_on: null, required: false }, '2026-10-20').ok).toBe(true);
    expect(complianceMark({ status: 'MISSING', expires_on: null, required: true }, '2026-10-20').ok).toBe(false);
  });
  it('seam alarm in plain language', () => {
    expect(worstAlarm(['OK', 'WARN'])).toBe('WARN');
    expect(seamSentence('ALARM', 3, 3 * 1440)).toBe('Merit Books has not picked up 3 records for more than a day (oldest 3 d). Bills, costs and invoices from these are not in the ledger yet; tell your Merit Books administrator.');
    expect(seamSentence('OK', 0, null)).toBe('Nothing is waiting on Merit Books.');
  });
});

describe('roll-ups', () => {
  it('billed to date counts EMITTED | ISSUED | UNISSUED | REJECTED, not releases, drafts or voids', () => {
    const reqs = [
      { id: '1', status: 'ISSUED', billing_subtype: 'SOV', gross_earned_cents: 21_000_000 },
      { id: '2', status: 'REJECTED', billing_subtype: 'SOV', gross_earned_cents: 18_500_000 },
      { id: '3', status: 'DRAFT', billing_subtype: null, gross_earned_cents: 1 },
      { id: '4', status: 'EMITTED', billing_subtype: 'RETAINAGE_RELEASE', gross_earned_cents: 0 },
      { id: '5', status: 'VOID', billing_subtype: null, gross_earned_cents: 7 },
    ] as const;
    expect(billedToDate(reqs as never)).toBe(39_500_000);
    expect(billedToDate(reqs as never, '2')).toBe(21_000_000);
    expect(heldToDate(reqs as never, [
      { billing_request_id: '1', line_type: 'STANDARD', retainage_this_period_cents: 2_100_000 },
      { billing_request_id: '1', line_type: 'RETAINAGE', retainage_this_period_cents: 0 },
      { billing_request_id: '3', line_type: 'STANDARD', retainage_this_period_cents: 99 },
    ])).toBe(2_100_000);
  });
  it('bands and who may send', () => {
    expect(billingBand({ status: 'DRAFT', failing_preconditions: ['PRECONDITION_NO_CUSTOMER'] })).toBe('draft');
    expect(billingBand({ status: 'DRAFT', failing_preconditions: [] })).toBe('ready');
    expect(billingBand({ status: 'VOID' })).toBeNull();
    expect(canSend({ kind: 'BILLING', status: 'REJECTED', failing_preconditions: [] })).toBe(true);
    expect(canSend({ kind: 'DEPOSIT', status: 'REJECTED', failing_preconditions: [] })).toBe(false);
  });
  it('commitment totals from v_commitment_status lines (harness: 21M + 1M CCO = 22M revised)', () => {
    const line = (o: Partial<CommitmentStatusRow>): CommitmentStatusRow => ({
      org_id: 'o', job_id: 'j', location_id: 'l', commitment_id: 'c1', number: 'SC-1', commitment_type: 'SUBCONTRACT', vendor_id: 'v', vendor_name: 'Pipe Co', status: 'APPROVED', version: 2,
      retainage_pct: 0.1, manual_hold: false, hold_reason: null, compliance_ok: true, payment_hold_effective: false, commitment_line_id: 'l1', line_no: 1, cost_code_id: 'cc', cost_code: '15',
      cost_type: 'SUBCONTRACTOR', description: 'Plumbing', original_amount_cents: 21_000_000, approved_change_cents: 1_000_000, revised_amount_cents: 22_000_000, billed_cents: 8_000_000,
      open_cents: 14_000_000, over_billed_cents: 0, qty: null, uom: null, unit_cost_cents: null, received_qty: 0, received_cents: 10_000_000, received_not_billed_cents: 2_000_000, pct_billed: 0.3636, ...o,
    });
    const t = commitmentTotals([line({}), line({ commitment_line_id: 'l2', original_amount_cents: 0, approved_change_cents: 0, revised_amount_cents: 0, billed_cents: 500, open_cents: 0, over_billed_cents: 500, received_cents: 0, received_not_billed_cents: 0 })]).get('c1')!;
    expect(t).toMatchObject({ committed: 22_000_000, original: 21_000_000, changes: 1_000_000, billed: 8_000_500, open: 14_000_000, overBilled: 500, received: 10_000_000, lines: 2, vendorName: 'Pipe Co' });
  });
  it('margin fade: sold margin less projected margin, worst first', () => {
    const f = (id: string, oc: number, ob: number | null, rc: number, pm: number) => ({ job_id: id, original_contract_cents: oc, budget_original_cents: ob, revised_contract_cents: rc, projected_margin_cents: pm }) as unknown as JobFinancialsRow;
    const a = f('a', 100_000_000, 70_000_000, 100_000_000, 27_500_000); // 30% sold → 27.5% now: 2.5 pts
    const b = f('b', 100_000_000, 80_000_000, 100_000_000, 10_000_000); // 20% → 10%: 10 pts
    const c = f('c', 0, null, 5_000_000, -1);
    expect(marginFade(a)).toBeCloseTo(0.025, 10);
    expect(byFade([a, c, b]).map((x) => x.job_id)).toEqual(['b', 'a', 'c']);
  });
  it('estimate totals flag costed lines without a cost code (PM_ESTIMATE_UNCODED)', () => {
    expect(estimateTotals([
      { amount_cents: 100_000_000, cost_cents: 70_000_000, is_allowance: false, cost_code_id: 'cc' },
      { amount_cents: 5_000, cost_cents: 5_000, is_allowance: true, cost_code_id: null },
    ])).toEqual({ sell: 100_005_000, cost: 70_005_000, margin: 30_000_000, marginPct: 30_000_000 / 100_005_000, allowances: 5_000, uncoded: 1 });
  });
});
