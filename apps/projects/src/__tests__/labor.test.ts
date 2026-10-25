/**
 * Labor rate math (client parity with 1108_pm_parties_and_labor.sql), the copy rule, time
 * approval guards, and the labor error copy. Numbers are the 1108 PGlite harness numbers
 * (/home/claude/pmtest/run-1108.mjs), so a drift on either side fails here or there.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LABOR_COST_RULE, PAY_TYPE_FACTOR, costRateCents, effectivePct, estimatingRateCents, fractionToPercentText, laborRates, percentTextToFraction,
  pinnedCostRateCents, priceLaborLine,
} from '@/lib/pm/labor/math';
import { laborBreakdown, laborTooltip, overheadInLines } from '@/lib/pm/labor/estimate';
import { approveBlock, lateLabel, needsLateAck, sentToBooks } from '@/lib/pm/labor/time';
import { LABOR_ERROR_COPY, laborErrorCopy } from '@/lib/pm/labor/errors';
import { AckLateTimeBody, ApproveTimeBody, LaborSettingsBody, cardKeyFrom } from '@/lib/pm/labor/schemas';
import { DEFAULT_BOOKS_URL, booksUrl } from '@/lib/books-url';

const MIG = resolve(__dirname, '../../../../packages/supabase/migrations');
const sql = readFileSync(resolve(MIG, '1108_pm_parties_and_labor.sql'), 'utf8');
const fnBody = (name: string) => {
  const start = sql.indexOf(`create or replace function pm.${name}(`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('end $$;', start));
};

describe('rate math: cost = pay × (1 + burden); estimating = cost basis × (1 + overhead)', () => {
  it('the owner example: $30.00, 25% burden, 15% overhead → $37.50 cost, $43.13 estimating', () => {
    expect(costRateCents(3000, 0.25)).toBe(3750);
    expect(estimatingRateCents(3000, 0.25, 0.15)).toBe(4313); // 4312.5 rounds half-up
    expect(laborRates(3000, 0.25, 0.15)).toEqual({ costRateCents: 3750, estimatingRateCents: 4313, overheadRateCents: 563 });
  });

  it('rounds once from the exact product (no float drift, no intermediate rounding)', () => {
    // 2999 × 1.2525 = 3756.2475 → 3756; × 1.1 = 4131.87225 → 4132 (rounding the cost first would give 4132 too, so check a case where it differs)
    expect(estimatingRateCents(2999, '0.2525', '0.1')).toBe(4132);
    // 1 × 1.5 × 1.5 = 2.25 → 2; rounding the intermediate (1.5 → 2) then × 1.5 = 3 would be wrong
    expect(estimatingRateCents(1, 0.5, 0.5)).toBe(2);
    expect(costRateCents(1, 0.5)).toBe(2); // 1.5 → 2 half-up
    expect(costRateCents(3333, 0.0001)).toBe(3333); // 3333.3333
    expect(costRateCents(0, 0.3)).toBe(0);
    expect(() => costRateCents(10.5, 0.1)).toThrow(RangeError);
  });

  it('card overrides: $40 × 1.30 = $52.00 cost; × 1.20 = $62.40 estimating', () => {
    expect(laborRates(4000, 0.3, 0.2)).toEqual({ costRateCents: 5200, estimatingRateCents: 6240, overheadRateCents: 1040 });
  });

  it('approval pins pay + burden × pay type and never overhead', () => {
    expect(pinnedCostRateCents(3000, 0.25, 'REG')).toBe(3750);
    expect(pinnedCostRateCents(3000, 0.25, 'OT')).toBe(5625);
    expect(pinnedCostRateCents(3000, 0.25, 'DT')).toBe(7500);
    expect(pinnedCostRateCents(3000, 0.25, 'PIECE')).toBe(3750);
    expect(pinnedCostRateCents(3000, 0.25, 'FLAG')).toBe(3750);
    expect(pinnedCostRateCents(2500, 0, 'REG')).toBe(2500);
    expect(PAY_TYPE_FACTOR).toEqual({ REG: '1', OT: '1.5', DT: '2', PIECE: '1', FLAG: '1' });
  });

  it('a line is hours × the cent rates; cost + overhead = estimating to the cent', () => {
    const r = laborRates(3000, 0.25, 0.15);
    expect(priceLaborLine(r, 10)).toEqual({ costCents: 37500, estimatingCents: 43130, overheadCents: 5630 });
    expect(priceLaborLine(r, '12')).toEqual({ costCents: 45000, estimatingCents: 51756, overheadCents: 6756 });
    expect(priceLaborLine(r, '0.3333')).toEqual({ costCents: 1250, estimatingCents: 1438, overheadCents: 188 });
  });

  it('inherits the company default, else 0', () => {
    expect(effectivePct(null, 0.25)).toBe(0.25);
    expect(effectivePct(0.3, 0.25)).toBe(0.3);
    expect(effectivePct(undefined, undefined)).toBe(0);
  });

  it('percent text ↔ fraction (two decimals of a percent, 0–500)', () => {
    expect(percentTextToFraction('25')).toBe(0.25);
    expect(percentTextToFraction('12.75%')).toBe(0.1275);
    expect(percentTextToFraction('0')).toBe(0);
    expect(percentTextToFraction('500')).toBe(5);
    expect(percentTextToFraction('500.01')).toBeNull();
    expect(percentTextToFraction('-1')).toBeNull();
    expect(percentTextToFraction('1.234')).toBeNull();
    expect(fractionToPercentText(0.1275)).toBe('12.75');
    expect(fractionToPercentText(0.25)).toBe('25');
    expect(fractionToPercentText(null)).toBe('');
  });

  it('the SQL uses the same formulas (view, helper, approval)', () => {
    expect(sql).toContain('round(c.base_rate_cents * (1 + r.burden))::bigint                       as cost_rate_cents');
    expect(sql).toContain('round(c.base_rate_cents * (1 + r.burden) * (1 + r.overhead))::bigint    as estimating_rate_cents');
    const approve = fnBody('approve_time_entries');
    expect(approve).toContain('round(v_base * (1 + v_burden) * pm.pay_type_factor(te.pay_type))::bigint');
    // job cost never reads the overhead allocation
    expect(approve).not.toMatch(/overhead_pct|default_overhead/);
    expect(fnBody('pay_type_factor')).toMatch(/'OT' then 1\.5 when 'DT' then 2\.0 else 1\.0/);
  });
});

describe('the copy rule', () => {
  it('is the owner’s plain-language rule, word for word', () => {
    expect(LABOR_COST_RULE).toBe(
      'Job cost uses pay + burden. Estimates add overhead so bids recover it; overhead is earned back in gross margin, never charged to the job.',
    );
  });
  it('the time page no longer promises approval "in a later release"', () => {
    const view = readFileSync(resolve(__dirname, '../components/ops/records/TimeView.tsx'), 'utf8');
    expect(view).not.toMatch(/later release/i);
    expect(view).toContain('Sent to Merit Books');
    expect(view).toContain('/api/ops/time/approve');
  });
  it('the labor tooltip names both parts and says overhead is never charged to the job', () => {
    const b = laborBreakdown({ _labor: { rate_card_id: 'c1', label: 'Carpenter', hours: 10, cost_rate_cents: 3750, estimating_rate_cents: 4313, overhead_rate_cents: 563, cost_cents: 37500, overhead_cents: 5630, estimating_cents: 43130, burden_pct: 0.25, overhead_pct: 0.15 } })!;
    expect(b.overheadCents).toBe(5630);
    const t = laborTooltip(b, (c) => `$${(c / 100).toFixed(2)}`);
    expect(t).toContain('job cost $37.50/h (pay + burden) + overhead $5.63/h = estimating $43.13/h');
    expect(t).toContain('never charged to the job');
    expect(overheadInLines([{ ext: { _labor: { rate_card_id: 'c1', cost_rate_cents: 1, estimating_rate_cents: 2, overhead_cents: 5630 } }, labor_rate_card_id: 'c1' }, { ext: {}, labor_rate_card_id: null }])).toBe(5630);
    expect(laborBreakdown({})).toBeNull();
    expect(laborBreakdown({ _labor: { rate_card_id: 'c1' } })).toBeNull();
  });
});

describe('time approval guards (mirror pm.approve_time_entries)', () => {
  const clerk = (id: string) => ({ e1: 'user_worker', e2: 'user_lead' } as Record<string, string>)[id] ?? null;
  const t = (o: Partial<{ approval_state: string; created_by: string | null; user_id: string | null; employee_id: string | null }>) =>
    ({ approval_state: 'SUBMITTED', created_by: 'user_pm', user_id: null, employee_id: 'e1', ...o });
  it('only submitted time, never your own entry or your own hours', () => {
    expect(approveBlock(t({}), 'user_pm2', clerk)).toBeNull();
    expect(approveBlock(t({}), 'user_pm', clerk)).toBe('YOURS');
    expect(approveBlock(t({}), 'user_worker', clerk)).toBe('YOURS');
    expect(approveBlock(t({ employee_id: null, user_id: 'user_pm2' }), 'user_pm2', clerk)).toBe('YOURS');
    expect(approveBlock(t({ approval_state: 'DRAFT' }), 'user_pm2', clerk)).toBe('NOT_SUBMITTED');
    expect(approveBlock(t({ approval_state: 'APPROVED' }), 'user_pm2', clerk)).toBe('NOT_SUBMITTED');
    expect(approveBlock(t({}), '', clerk)).toBe('YOURS');
  });
  it('"Sent to Merit Books" only when an event exists', () => {
    expect(sentToBooks({ approval_state: 'APPROVED', event_id: 'ev' })).toBe(true);
    expect(sentToBooks({ approval_state: 'APPROVED', event_id: null })).toBe(false);
    expect(sentToBooks({ approval_state: 'SUBMITTED', event_id: 'ev' })).toBe(false);
  });
  it('bulk body: 1–500 uuids', () => {
    expect(ApproveTimeBody.safeParse({ ids: [] }).success).toBe(false);
    expect(ApproveTimeBody.safeParse({ ids: ['0bf579d0-7e25-421c-956c-4f1be58fa640'] }).success).toBe(true);
    expect(ApproveTimeBody.safeParse({ ids: ['nope'] }).success).toBe(false);
  });
});

describe('labor settings body and errors', () => {
  it('fractions 0–5 with up to 4 decimals', () => {
    const C = '0bf579d0-7e25-421c-956c-4f1be58fa640';
    expect(LaborSettingsBody.safeParse({ companyId: C, burdenPct: 0.2875, overheadPct: 0.15 }).success).toBe(true);
    expect(LaborSettingsBody.safeParse({ companyId: C, burdenPct: 25, overheadPct: 0.15 }).success).toBe(false);
    expect(LaborSettingsBody.safeParse({ companyId: C, burdenPct: -0.1, overheadPct: 0 }).success).toBe(false);
    expect(LaborSettingsBody.safeParse({ companyId: C, burdenPct: 0.123456, overheadPct: 0 }).success).toBe(false);
  });
  it('card keys from labels', () => {
    expect(cardKeyFrom('Finish carpenter')).toBe('finish_carpenter');
    expect(cardKeyFrom('2nd-year apprentice')).toBe('r_2nd_year_apprentice');
    expect(cardKeyFrom('A')).toBe('a_x');
  });
  it('every time / rate-card token the migration raises has words', () => {
    const raised = [...new Set([...sql.matchAll(/raise exception '([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!))];
    const shared = ['PM_FORBIDDEN', 'PM_INVALID', 'PM_NO_ACTOR', 'PM_UNKNOWN_RATE_CARD'];
    expect(raised.filter((t) => !(t in LABOR_ERROR_COPY) && !shared.includes(t))).toEqual([]);
    expect(laborErrorCopy({ code: '42501', message: 'PM_SOD_VIOLATION: 2 time entries were entered by you or for you' })?.error).toMatch(/someone else has to approve/);
    const nr = laborErrorCopy({ code: '22023', message: 'PM_NO_LABOR_RATE: the 5.00 hours on 2026-10-20 have no pay rate' });
    expect(nr?.status).toBe(422);
    expect(nr?.error).toMatch(/^The 5\.00 hours on 2026-10-20 have no pay rate\. Set the pay rate in Merit Books/);
    expect(laborErrorCopy({ code: '22023', message: 'PM_TIME_BILLED: x' })?.error).toMatch(/Void that billing first/);
    expect(laborErrorCopy({ code: '22023', message: 'PM_SOMETHING_ELSE: x' })).toBeNull();
  });
});

describe('Merit Books URL', () => {
  it('defaults to books.meritmgt.com and trims the trailing slash', () => {
    expect(DEFAULT_BOOKS_URL).toBe('https://books.meritmgt.com');
    expect(booksUrl('')).toBe('https://books.meritmgt.com');
    expect(booksUrl('https://books.example.com/')).toBe('https://books.example.com');
  });
});

describe('late phone / kiosk time (1125)', () => {
  const ID = '0bf579d0-7e25-421c-956c-4f1be58fa640';
  it('"entered N h late" with the database\'s rounding', () => {
    expect(lateLabel(210)).toBe('entered 3.5 h late');
    expect(lateLabel(20)).toBe('entered 0.3 h late');
    expect(lateLabel(null)).toBe('entered 0.0 h late');
  });
  it('a late entry needs acknowledgment until it is acknowledged, approved or void', () => {
    expect(needsLateAck({ late_tap: true, late_ack_at: null, approval_state: 'SUBMITTED' })).toBe(true);
    expect(needsLateAck({ late_tap: true, late_ack_at: null, approval_state: 'DRAFT' })).toBe(true);
    expect(needsLateAck({ late_tap: true, late_ack_at: '2026-10-21T12:00:00Z', approval_state: 'SUBMITTED' })).toBe(false);
    expect(needsLateAck({ late_tap: true, late_ack_at: null, approval_state: 'APPROVED' })).toBe(false);
    expect(needsLateAck({ late_tap: false, late_ack_at: null, approval_state: 'SUBMITTED' })).toBe(false);
  });
  it('the database sentences become plain copy (kept detail, split at the semicolon)', () => {
    const late = laborErrorCopy({ code: '22023', message: 'PM_LATE_TAP: this time was entered 3.5 h late from the phone; acknowledge it individually to approve' });
    expect(late).toEqual({ status: 422, code: 'PM_LATE_TAP', error: 'This time was entered 3.5 h late from the phone. Acknowledge it individually to approve.' });
    expect(laborErrorCopy({ code: '55000', message: 'PM_TIME_WEEK_LOCKED: the week of Oct 19 already has approved time; the service manager enters this punch' }))
      .toEqual({ status: 409, code: 'PM_TIME_WEEK_LOCKED', error: 'The week of Oct 19 already has approved time. The service manager enters this punch.' });
    expect(laborErrorCopy({ code: '22023', message: 'PM_PUNCH_STALE: the clock-on was tapped more than 72 hours ago; the service manager enters it' })?.status).toBe(422);
    expect(laborErrorCopy({ code: '22023', message: "PM_CLOCK_AHEAD: the clock-on time is in the future; turn on the phone's automatic date and time" })?.error)
      .toBe("The clock-on time is in the future. Turn on the phone's automatic date and time.");
    expect(laborErrorCopy({ code: '55000', message: 'PM_PUNCH_OVERLAP: ' })?.error).toMatch(/later punch is already on this person/);
  });
  it('approve may name the late entries it acknowledges, only among the ones approved', () => {
    expect(ApproveTimeBody.safeParse({ ids: [ID] }).success).toBe(true);
    expect(ApproveTimeBody.safeParse({ ids: [ID], ackLate: [ID] }).success).toBe(true);
    expect(ApproveTimeBody.safeParse({ ids: [ID], ackLate: ['1bf579d0-7e25-421c-956c-4f1be58fa640'] }).success).toBe(false);
    expect(AckLateTimeBody.safeParse({ ids: [] }).success).toBe(false);
    expect(AckLateTimeBody.safeParse({ ids: [ID] }).success).toBe(true);
  });
  it('the approve route refuses unacknowledged late time before approving anything, and the ack route uses pm.dlr_ack_late_time', () => {
    const approve = readFileSync(resolve(__dirname, '../app/api/ops/time/approve/route.ts'), 'utf8');
    expect(approve.indexOf("'PM_LATE_TAP'")).toBeGreaterThan(0);
    expect(approve.indexOf("'PM_LATE_TAP'")).toBeLessThan(approve.indexOf('approveTimeEntries(db'));
    expect(approve).toContain("rpc('dlr_ack_late_time'");
    expect(readFileSync(resolve(__dirname, '../app/api/ops/time/ack/route.ts'), 'utf8')).toContain("rpc('dlr_ack_late_time'");
  });
});
