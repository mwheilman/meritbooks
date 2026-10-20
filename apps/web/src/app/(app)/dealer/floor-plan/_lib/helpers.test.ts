import { describe, expect, it } from 'vitest';
import { describeSchedule, newScheduleRow, rulesToDrafts, validateSchedule } from './schedule';
import { draftEffectiveRateBps, validateFloor, validateLine, validateProgram, type FloorDraft, type LineDraft, type ProgramDraft } from './forms';
import { blankLine, checkFooting, normalizeDate, parsePastedLines, toApiLines, validateLines } from './statement-entry';
import { curtailmentUrgency, payoffsToPropose, sortSotFindings, utilizationTone } from './queues';
import { buildCurtailmentSchedule } from '@/lib/dealer/engine/notes';
import { lineCreate, programCreate, floorBody, lenderStatementImport } from '@/lib/validations/dealer';
import type { SotFinding } from '@/lib/dealer/engine/sot';
import type { FpNote } from './types';

const LOC = '00000000-0000-4000-8000-000000000001';
const UUID = '00000000-0000-4000-8000-0000000000aa';

describe('curtailment schedule editor', () => {
  it('turns valid rows into the API rule union, sorted by days', () => {
    const v = validateSchedule([
      newScheduleRow({ afterDays: '270', mode: 'amount', amountCents: 50_000 }),
      newScheduleRow({ afterDays: '180', mode: 'pct', pct: '10' }),
    ]);
    expect(v.ok).toBe(true);
    expect(v.rules).toEqual([{ after_days: 180, pct_bps: 1000 }, { after_days: 270, amount_cents: 50_000 }]);
  });

  it('rejects zero / duplicate days and out-of-range percents', () => {
    const a = newScheduleRow({ afterDays: '0', pct: '10' });
    const b = newScheduleRow({ afterDays: '90', pct: '10' });
    const c = newScheduleRow({ afterDays: '90', pct: '5' });
    const d = newScheduleRow({ afterDays: '120', pct: '101' });
    const e = newScheduleRow({ afterDays: '150', mode: 'amount', amountCents: null });
    const v = validateSchedule([a, b, c, d, e]);
    expect(v.ok).toBe(false);
    expect(Object.keys(v.errors).sort()).toEqual([a.key, c.key, d.key, e.key].sort());
  });

  it('round-trips stored jsonb and previews with the flooring engine (AC4: day 180, 10%)', () => {
    const drafts = rulesToDrafts([{ after_days: 180, pct_bps: 1000 }, { bogus: true }]);
    expect(drafts).toHaveLength(1);
    const { rules } = validateSchedule(drafts);
    const sched = buildCurtailmentSchedule('2026-01-01', 1_000_000, rules);
    expect(sched).toEqual([{ sequence: 1, dueDate: '2026-06-30', amountCents: 100_000 }]);
    expect(describeSchedule([{ after_days: 180, pct_bps: 1000 }])).toBe('10% at 180 days');
    expect(describeSchedule([])).toBe('No curtailments');
  });

  it('every rule the editor emits passes the server schema', () => {
    const { rules } = validateSchedule([newScheduleRow({ afterDays: '180', pct: '12.5' }), newScheduleRow({ afterDays: '365', mode: 'amount', amountCents: 1 })]);
    const parsed = programCreate.safeParse({
      locationId: LOC, lineId: UUID, name: 'P', freeFloorDays: 0, rateType: 'FIXED', rateBps: 900, dayCount: 'ACT_365', payoffTerms: 'PAY_AS_SOLD', payoffDays: 0, curtailmentSchedule: rules,
    });
    expect(parsed.success).toBe(true);
  });
});

function lineDraft(p: Partial<LineDraft> = {}): LineDraft {
  return { lenderVendorId: UUID, name: 'Wholegoods', creditLimitCents: 500_000_00, liabilityAccountId: null, interestDueDay: '15', scheduledPaymentDay: '', statementDay: '', sauCodes: ['np', ' NP ', 'sld'], status: 'ACTIVE', notes: '', ...p };
}

describe('line form', () => {
  it('builds a body the server accepts (codes de-duplicated and upper-cased)', () => {
    const { body } = validateLine(lineDraft());
    expect(body?.sauCodes).toEqual(['NP', 'SLD']);
    expect(body?.interestDueDay).toBe(15);
    expect(lineCreate.safeParse({ locationId: LOC, ...body }).success).toBe(true);
  });
  it('refuses a missing lender, a bad day and a negative limit', () => {
    const { body, errors } = validateLine(lineDraft({ lenderVendorId: null, interestDueDay: '32', creditLimitCents: -1 }));
    expect(body).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['creditLimitCents', 'interestDueDay', 'lenderVendorId']);
  });
});

function programDraft(p: Partial<ProgramDraft> = {}): ProgramDraft {
  return {
    lineId: UUID, oemVendorId: null, name: 'New units', freeFloorDays: '90', rateType: 'FIXED', ratePct: '9', indexName: '', indexRatePct: '', spreadPct: '', penaltyPct: '21.9',
    dayCount: 'ACT_365', payoffTerms: 'PAY_AS_SOLD', payoffDays: '', maxTermDays: '730', curtailDemos: false, effectiveFrom: '', effectiveTo: '', status: 'ACTIVE', ...p,
  };
}

describe('program form', () => {
  it('fixed rate → bps; penalty rate; server accepts', () => {
    const { body } = validateProgram(programDraft(), { rules: [], ok: true });
    expect(body?.rateBps).toBe(900);
    expect(body?.sauPenaltyRateBps).toBe(2190);
    expect(body?.payoffDays).toBe(0);
    expect(programCreate.safeParse({ locationId: LOC, ...body }).success).toBe(true);
  });
  it('index plus spread → effective rate and index fields (spread may be negative)', () => {
    const d = programDraft({ rateType: 'INDEX_PLUS', indexName: 'Base', indexRatePct: '7.5', spreadPct: '-0.25' });
    expect(draftEffectiveRateBps(d)).toBe(725);
    const { body } = validateProgram(d, { rules: [], ok: true });
    expect(body).toMatchObject({ rateBps: 725, indexRateBps: 750, spreadBps: -25, indexName: 'Base' });
    expect(programCreate.safeParse({ locationId: LOC, ...body }).success).toBe(true);
  });
  it('days-after-sale needs payoff days; end before start is refused; bad schedule blocks', () => {
    const { errors } = validateProgram(programDraft({ payoffTerms: 'DAYS_AFTER_SALE', payoffDays: '', effectiveFrom: '2026-05-01', effectiveTo: '2026-04-01' }), { rules: [], ok: false });
    expect(Object.keys(errors).sort()).toEqual(['curtailmentSchedule', 'effectiveTo', 'payoffDays']);
  });
});

function floorDraft(p: Partial<FloorDraft> = {}): FloorDraft {
  return {
    lineId: UUID, programId: null, collateralType: 'WHOLE_GOOD', lenderInvoiceNumber: ' INV-1 ', flooredDate: '2026-10-01', principalCents: 1_000_000, description: '', scheduledDueDate: '',
    unitMode: 'new', unitId: null, serialNumber: 'SN123', makeVendorId: null, model: 'Z-1', modelYear: '2026', condition: 'NEW', postNow: false, ...p,
  };
}

describe('manual flooring form', () => {
  it('new unit body matches floorBody', () => {
    const { body } = validateFloor(floorDraft());
    expect(body?.lenderInvoiceNumber).toBe('INV-1');
    expect(body?.unit).toMatchObject({ serialNumber: 'SN123', modelYear: 2026, source: 'MANUAL' });
    expect(floorBody.safeParse({ locationId: LOC, ...body }).success).toBe(true);
  });
  it('existing unit sends unitId only; open account sends no unit', () => {
    const a = validateFloor(floorDraft({ unitMode: 'existing', unitId: UUID })).body;
    expect(a?.unitId).toBe(UUID);
    expect(a?.unit).toBeUndefined();
    const b = validateFloor(floorDraft({ collateralType: 'OPEN_ACCOUNT', scheduledDueDate: '2026-10-25' })).body;
    expect(b?.unit).toBeUndefined();
    expect(floorBody.safeParse({ locationId: LOC, ...b }).success).toBe(true);
  });
  it('requires a positive principal and a serial for a new unit', () => {
    const { errors } = validateFloor(floorDraft({ principalCents: 0, serialNumber: ' ' }));
    expect(Object.keys(errors).sort()).toEqual(['principalCents', 'serialNumber']);
  });
});

describe('statement entry', () => {
  const l1 = { ...blankLine(), lenderInvoiceNumber: 'A1', currentCents: 600_000, interestCents: 1_000 };
  const l2 = { ...blankLine(), serialNumber: 'S2', currentCents: 400_000, interestCents: 500, lenderCode: 'np' };
  const empty = blankLine();

  it('foots in dollars and ignores blank rows (AC11)', () => {
    const ok = checkFooting([l1, empty, l2], { principalCents: 1_000_000, interestCents: 1_500, feesCents: null, lineCount: '2' });
    expect(ok.ok).toBe(true);
    const bad = checkFooting([l1, l2], { principalCents: 999_999, interestCents: null, feesCents: null, lineCount: '3' });
    expect(bad.ok).toBe(false);
    expect(bad.rows[0]).toMatchObject({ ok: false, linesTotal: '$10,000.00', footer: '$9,999.99' });
    expect(bad.rows[3].ok).toBe(false);
    expect(checkFooting([l1], { principalCents: null, interestCents: null, feesCents: null, lineCount: '' }).ok).toBe(false);
  });

  it('builds API lines the server schema accepts', () => {
    const api = toApiLines([l1, empty, l2]);
    expect(api).toHaveLength(2);
    expect(api[1].lenderCode).toBe('NP');
    expect(
      lenderStatementImport.safeParse({ locationId: LOC, lineId: UUID, kind: 'AUDIT', statementDate: '2026-09-30', footer: { principalCents: 1_000_000 }, lines: api }).success,
    ).toBe(true);
  });

  it('flags a line with nothing to match on', () => {
    const e = validateLines([{ ...blankLine(), currentCents: 5 }]);
    expect(Object.values(e)[0]).toMatch(/invoice #, serial or model/);
  });

  it('parses pasted spreadsheet rows, skipping a header', () => {
    const text = 'Invoice\tSerial\tModel\tOriginal\tCurrent\tInterest\tFees\tCode\tDisposition\tDays\nINV9\tSN9\tX\t$1,000.00\t900.50\t3.25\t\tNP\t9/30/2026\t12\n\n';
    const { lines, skipped } = parsePastedLines(text);
    expect(skipped).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ lenderInvoiceNumber: 'INV9', originalCents: 100_000, currentCents: 90_050, interestCents: 325, feesCents: null, dispositionDate: '2026-09-30', days: '12' });
    expect(normalizeDate('09/30/26')).toBe('2026-09-30');
    expect(normalizeDate('13/01/2026')).toBeNull();
  });
});

describe('queues', () => {
  const note = (id: string, p: Partial<FpNote>): FpNote => ({
    id, location_id: LOC, line_id: UUID, program_id: null, unit_id: null, collateral_type: 'WHOLE_GOOD', lender_invoice_number: id, description: null, floored_date: '2026-01-01',
    original_principal_cents: 100, principal_balance_cents: 100, free_floor_end_date: null, maturity_date: null, scheduled_due_date: null, interest_accrued_through: null,
    status: 'SOLD_UNPAID', sold_date: '2026-10-01', payoff_due_date: '2026-10-01', paid_off_date: null, sold_detected_by: 'BOOKS_SALE', is_opening: false, import_batch_id: null,
    created_at: '2026-01-01', ...p,
  });

  it('payoffs to propose excludes notes with an open proposal, earliest due first', () => {
    const out = payoffsToPropose(
      [note('a', { payoff_due_date: '2026-10-05' }), note('b', { payoff_due_date: '2026-10-02' }), note('c', {}), note('d', { principal_balance_cents: 0 })],
      [{ note_id: 'c', status: 'PROPOSED' }],
    );
    expect(out.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('sorts SOT critical first, then most days past due', () => {
    const f = (id: string, severity: 'CRITICAL' | 'HIGH', daysPastDue: number) => ({ noteId: id, severity, daysPastDue, principalCents: 1 }) as SotFinding;
    expect(sortSotFindings([f('h', 'HIGH', 9), f('c1', 'CRITICAL', 1), f('c2', 'CRITICAL', 5)]).map((x) => x.noteId)).toEqual(['c2', 'c1', 'h']);
  });

  it('curtailment urgency (DL-2) and utilization tone (DL-10)', () => {
    expect(curtailmentUrgency({ status: 'DUE', due_date: '2026-10-25' }, '2026-10-20', 7)).toBe('soon');
    expect(curtailmentUrgency({ status: 'DUE', due_date: '2026-11-25' }, '2026-10-20', 7)).toBe('later');
    expect(curtailmentUrgency({ status: 'DUE', due_date: '2026-10-19' }, '2026-10-20', 7)).toBe('overdue');
    expect(curtailmentUrgency({ status: 'MISSED', due_date: '2026-10-19' }, '2026-10-20', 7)).toBe('missed');
    expect(curtailmentUrgency({ status: 'PAID', due_date: '2026-10-19' }, '2026-10-20', 7)).toBe('settled');
    expect(utilizationTone(9500, 9000, 'ACTIVE')).toBe('warning');
    expect(utilizationTone(5000, 9000, 'CREDIT_HOLD')).toBe('danger');
    expect(utilizationTone(10_100, 9000, 'ACTIVE')).toBe('danger');
    expect(utilizationTone(null, 9000, 'ACTIVE')).toBe('ok');
  });
});
