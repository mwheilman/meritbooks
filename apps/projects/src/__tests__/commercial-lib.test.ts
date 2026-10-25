/**
 * Commercial (1120) browser mirrors: the money math, the field rules, the voice parser, the
 * status words and the error sentences. The SQL side is checked against these same functions in
 * packages/projects-access/test/commercial.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { computeMarkup, g702Summary, g703Line, G703Error, overUnderAfter, retainageLine, roundCents, stepRate, wipRow } from '@/lib/commercial/math';
import { checkCoi, divisionOf, fadeSeverity, priceTicket, productivity, submitBy, waiverDocType, waiverFormKey } from '@/lib/commercial/field';
import { parseTranscript } from '@/lib/commercial/voice';
import { CHANGE_EVENT_STATUS, PAY_APP_STAGE, mark, pctText } from '@/lib/commercial/labels';
import { mapCommercialError } from '@/lib/commercial/errors';
import { ChangeEventCreate, DailyLogAction, PayAppAction, RfiCreate, SubPayAppAction, TmCreate } from '@/lib/commercial/schemas';
import { daysSince, dueText, parseDollars, dollarsText } from '@/components/commercial/common';

describe('money math', () => {
  it('rounds half away from zero like Postgres round(numeric)', () => {
    expect([roundCents(2.5), roundCents(-2.5), roundCents(2.4999), roundCents(Number.NaN)]).toEqual([3, -3, 2, 0]);
  });

  it('picks the highest retainage step at or below completion', () => {
    const steps = [{ fromPct: 0.5, rate: 0.05 }, { fromPct: 0.9, rate: 0 }];
    expect([stepRate(steps, 0.3, 0.1), stepRate(steps, 0.5, 0.1), stepRate(steps, 0.95, 0.1)]).toEqual([0.1, 0.05, 0]);
  });

  it('retainage: new work only keeps what was held; reduce-to-date recomputes the whole balance', () => {
    const base = { rate: 0.05, storedRate: null, previousWork: 600000, thisPeriodWork: 400000, storedNow: 0, storedBefore: 0, heldBefore: 60000 };
    expect(retainageLine({ ...base, mode: 'NEW_WORK_ONLY' })).toEqual({ workToDate: 80000, storedToDate: 0, thisPeriod: 20000 });
    expect(retainageLine({ ...base, mode: 'REDUCE_TO_DATE' })).toEqual({ workToDate: 50000, storedToDate: 0, thisPeriod: -10000 });
  });

  it('installing stored material moves its retainage onto work', () => {
    const r = retainageLine({ mode: 'NEW_WORK_ONLY', rate: 0.1, storedRate: null, previousWork: 400000, thisPeriodWork: 400000, storedNow: 0, storedBefore: 50000, heldBefore: 45000 });
    expect(r.thisPeriod).toBe(35000);
  });

  it('G703 line: percent, work to date and the refusals', () => {
    const l = g703Line({ scheduled: 1500000, previousWork: 600000, previousStored: 0, pctComplete: 0.8 });
    expect([l.thisPeriodWork, l.totalCompleted, l.balanceToFinish, l.pct]).toEqual([600000, 1200000, 300000, 0.8]);
    expect(g703Line({ scheduled: 1000000, previousWork: 0, previousStored: 0, workToDate: 400000, storedNow: 50000 }).billedThisPeriod).toBe(450000);
    expect(() => g703Line({ scheduled: 100, previousWork: 0, previousStored: 0, pctComplete: 1.2 })).toThrow(G703Error);
    expect(() => g703Line({ scheduled: 100, previousWork: 0, previousStored: 0, workToDate: 90, storedNow: 20 })).toThrow(/exceed/);
  });

  it('G702 face ties to its lines', () => {
    const a = { ...g703Line({ scheduled: 1500000, previousWork: 0, previousStored: 0, pctComplete: 0.4 }), retainageWorkToDate: 60000, retainageStoredToDate: 0 };
    const b = { ...g703Line({ scheduled: 1000000, previousWork: 0, previousStored: 0, workToDate: 400000, storedNow: 50000 }), retainageWorkToDate: 40000, retainageStoredToDate: 5000 };
    const s = g702Summary([a, b], 2500000, 0);
    expect(s).toMatchObject({ contractSumToDate: 2500000, netChangeByCo: 0, totalCompletedStored: 1050000, retainageTotal: 105000, earnedLessRetainage: 945000, currentPaymentDue: 945000 });
    expect(s.balanceToFinishInclRetainage).toBe(2500000 - 945000);
  });

  it('markups: self-perform and sub families, then a compounding bond on the running total', () => {
    const r = computeMarkup([
      { kind: 'OHP', appliesTo: 'SELF_PERFORM', costType: null, pct: 0.1, compounding: false, tierMaxCents: null, sort: 1 },
      { kind: 'OHP', appliesTo: 'SUBCONTRACT', costType: null, pct: 0.05, compounding: false, tierMaxCents: null, sort: 2 },
      { kind: 'BOND', appliesTo: 'ALL', costType: null, pct: 0.01, compounding: true, tierMaxCents: null, sort: 3 },
    ], [{ costCents: 100000, costType: 'LABOR', source: 'SELF' }, { costCents: 180000, costType: 'SUBCONTRACTOR', source: 'SUB' }]);
    expect([r.costCents, r.markupCents, r.amountCents]).toEqual([280000, 21990, 301990]);
    expect(r.detail.map((d) => d.amountCents)).toEqual([10000, 9000, 2990]);
  });

  it('markup tiers pick the smallest tier that covers the base; caps and floors apply', () => {
    const rules = [
      { kind: 'FEE' as const, appliesTo: 'ALL' as const, costType: null, pct: 0.15, compounding: false, tierMaxCents: 1000000, sort: 1 },
      { kind: 'FEE' as const, appliesTo: 'ALL' as const, costType: null, pct: 0.1, compounding: false, tierMaxCents: null, sort: 1, maxCents: 150000 },
    ];
    expect(computeMarkup(rules, [{ costCents: 500000, costType: null, source: 'SELF' }]).markupCents).toBe(75000);
    expect(computeMarkup(rules, [{ costCents: 2000000, costType: null, source: 'SELF' }]).markupCents).toBe(150000);
  });

  it('WIP row: cost-to-cost earned, over/under, fade and the full loss now', () => {
    const w = wipRow({ contractCents: 1000000, eacCents: 800000, costToDateCents: 400000, excludedCents: 0, billedCents: 550000, priorGpPct: 0.25 });
    expect(w).toMatchObject({ pctComplete: 0.5, earnedCents: 500000, overBilledCents: 50000, underBilledCents: 0, gpCents: 200000, gpPct: 0.2, backlogCents: 500000, lossProvisionCents: 0 });
    expect(w.fadeGainPts).toBeCloseTo(-5, 6);
    const loss = wipRow({ contractCents: 1000000, eacCents: 1200000, costToDateCents: 600000, excludedCents: 0, billedCents: 0, priorGpPct: null });
    expect([loss.gpCents, loss.lossProvisionCents]).toEqual([-200000, 100000]);
    expect(wipRow({ contractCents: 100, eacCents: 0, costToDateCents: 50, excludedCents: 0, billedCents: 0, priorGpPct: null }).pctComplete).toBe(0);
  });

  it('over/under after this bill is null when earned is not visible', () => {
    expect([overUnderAfter(100, 50, 120), overUnderAfter(100, 50, null)]).toEqual([30, null]);
  });
});

describe('field rules', () => {
  it('productivity: earned hours from installed quantity; projected hours from the burn', () => {
    const p = productivity({ budgetQty: 1000, budgetHours: 500, unitHours: null, installedQty: 400, lastPct: null, pctEntry: false, actualHours: 300 });
    expect(p).toEqual({ pctComplete: 0.4, earnedHours: 200, productivityFactor: 0.6667, pctHoursUsed: 0.6, projectedHours: 750, varianceHours: 250 });
    expect(productivity({ budgetQty: null, budgetHours: 100, unitHours: null, installedQty: 0, lastPct: 0.25, pctEntry: true, actualHours: 0 }).productivityFactor).toBeNull();
  });

  it('fade severity by how far hours run ahead of completion', () => {
    expect([fadeSeverity(0.6, 0.4, 10, 10), fadeSeverity(0.47, 0.4, 10, 10), fadeSeverity(0.4, 0.4, 8, 10), fadeSeverity(0.4, 0.4, 10, 10)]).toEqual(['CRITICAL', 'FADE', 'WATCH', null]);
  });

  it('submit-by works back from the on-site date; divisions read from any section format', () => {
    expect(submitBy('2026-12-15', 42, 14)).toBe('2026-10-20');
    expect(submitBy(null, 10, 10)).toBeNull();
    expect([divisionOf('09 21 16'), divisionOf('092116'), divisionOf('26-05-00')]).toEqual(['09', '09', '26']);
  });

  it('T&M prices at the rate sheet: OT at 1.5×, material with markup', () => {
    const p = priceTicket([
      { kind: 'LABOR', laborClass: 'default', hoursSt: 8, hoursOt: 2, hoursDt: 0, qty: null, unitCostCents: null, equipmentHours: null, description: '' },
      { kind: 'MATERIAL', laborClass: null, hoursSt: 0, hoursOt: 0, hoursDt: 0, qty: 10, unitCostCents: 500, equipmentHours: null, description: 'Wire' },
    ], { laborRates: [{ class: 'default', st_cents: 10000 }], materialMarkupPct: 0.15, equipmentRates: [], equipmentMarkupPct: 0, subMarkupPct: 0.1 });
    expect([p.laborCents, p.laborHours, p.materialCents, p.totalCents]).toEqual([110000, 10, 5750, 115750]);
  });

  it('COI: endorsements match case-insensitively; a short limit or an expired policy is deficient', () => {
    const reqs = [
      { requirement: 'GL_EACH_OCCURRENCE' as const, minLimitCents: 100000000, maxValue: null, endorsementForms: [], required: true },
      { requirement: 'ADDITIONAL_INSURED_ONGOING' as const, minLimitCents: null, maxValue: null, endorsementForms: ['CG 20 10'], required: true },
    ];
    const coi = { policies: [{ type: 'GL', each_occurrence_cents: 200000000, aggregate_cents: 400000000, expires: '2027-01-01' }], endorsements: ['cg 20 10'], additionalInsured: true,
      waiverOfSubrogation: false, primaryNoncontributory: false, emr: null, w9OnFile: false, licenseNo: null, licenseExpires: null };
    expect(checkCoi(coi, reqs, '2026-10-25').status).toBe('VERIFIED');
    expect(checkCoi({ ...coi, endorsements: ['CG 20 37'] }, reqs, '2026-10-25').status).toBe('DEFICIENT');
    expect(checkCoi({ ...coi, policies: [{ ...coi.policies[0]!, each_occurrence_cents: 50000000 }] }, reqs, '2026-10-25').status).toBe('DEFICIENT');
    expect(checkCoi(coi, reqs, '2027-02-01').status).not.toBe('VERIFIED');
  });

  it('lien waiver form: the statutory state form when there is one, else the generic', () => {
    expect([waiverFormKey('CA', 'CONDITIONAL_PROGRESS'), waiverFormKey('IA', 'CONDITIONAL_PROGRESS'), waiverFormKey(null, 'UNCONDITIONAL_FINAL')])
      .toEqual(['CA_CONDITIONAL_PROGRESS', 'GENERIC_CONDITIONAL_PROGRESS', 'GENERIC_UNCONDITIONAL_FINAL']);
    expect([waiverDocType('CONDITIONAL_PROGRESS'), waiverDocType('UNCONDITIONAL_PROGRESS'), waiverDocType('CONDITIONAL_FINAL')])
      .toEqual(['LIEN_WAIVER_CONDITIONAL', 'LIEN_WAIVER_UNCONDITIONAL', 'LIEN_WAIVER_FINAL']);
  });
});

describe('voice → daily log proposals', () => {
  const dir = [{ vendorId: 'v1', name: 'Drywall Pros', trade: 'Drywall' }];
  it('manpower by company, a delay with its cause, a delivery and the rest as work performed', () => {
    const p = parseTranscript('Drywall Pros had 5 guys for 8 hours. We waited 2 hours on the inspector. Delivered 40 sticks of conduit from Graybar. Finished rough-in on level 2.', dir);
    expect(p.map((x) => x.kind)).toEqual(['MANPOWER', 'DELAY', 'DELIVERY', 'WORK_SUMMARY']);
    expect(p[0]).toMatchObject({ headcount: 5, hours: 8, vendor_id: 'v1', trade: 'Drywall', company_name: 'Drywall Pros' });
    expect(p[1]).toMatchObject({ cause: 'INSPECTION', duration_hours: 2 });
    expect(p[2]).toMatchObject({ supplier: 'Graybar' });
  });
  it('an inspection result is an inspection; rain is a weather delay; Spanish works', () => {
    expect(parseTranscript('Framing inspection passed.').map((x) => [x.kind, x.result])).toEqual([['INSPECTION', 'PASS']]);
    expect(parseTranscript('Rained out half the day.')[0]).toMatchObject({ kind: 'DELAY', cause: 'WEATHER', duration_hours: 4 });
    const es = parseTranscript('Cuatro plomeros de Rivera trabajaron 8 horas. Esperamos 1 hora por la lluvia.');
    expect(es[0]).toMatchObject({ kind: 'MANPOWER', headcount: 4, hours: 8, trade: 'Plumbing' });
    expect(es[1]).toMatchObject({ kind: 'DELAY', cause: 'WEATHER' });
  });
  it('nothing recognisable is all work performed; empty text proposes nothing', () => {
    expect(parseTranscript('Hung board on level two.').map((x) => x.kind)).toEqual(['WORK_SUMMARY']);
    expect(parseTranscript('')).toEqual([]);
  });
});

describe('labels, errors, schemas and screen helpers', () => {
  it('every status has a word and an unknown one reads as words, never a code', () => {
    expect(mark(CHANGE_EVENT_STATUS, 'SUBMITTED').word).toBe('With owner');
    expect(mark(PAY_APP_STAGE, 'PENCIL_SENT')).toMatchObject({ word: 'Pencil sent', kind: 'track' });
    expect(mark(CHANGE_EVENT_STATUS, 'SOME_NEW_STATE').word).toBe('some new state');
    expect(mark(CHANGE_EVENT_STATUS, null).word).toBe('—');
    expect([pctText(0.125, 1), pctText(null)]).toEqual(['12.5%', '—']);
  });

  it('1120 tokens map to plain sentences; refusals never leak detail; state errors are 409', () => {
    expect(mapCommercialError({ code: '42501', message: 'PM_MONEY_FORBIDDEN: pricing a change needs Contract value on this job' })).toMatchObject({ status: 403, body: { code: 'PM_MONEY_FORBIDDEN' } });
    expect(mapCommercialError({ code: '42501', message: 'PM_DAILY_LOG_LOCKED: the 2026-10-20 log is signed' }).body.error).toMatch(/amendment/);
    expect(mapCommercialError({ code: '22023', message: 'PM_PCO_EMPTY: PCO-004 has no lines' })).toEqual({ status: 422, body: { error: 'PCO-004 has no lines.', code: 'PM_PCO_EMPTY' } });
    expect(mapCommercialError({ code: '22023', message: 'PM_RFI_STATE: the RFI is closed' }).status).toBe(409);
    expect(mapCommercialError({ code: '22023', message: 'PRECONDITION_FINAL_WAIVER: SC-1 has no verified final waiver' }).status).toBe(422);
    const f = mapCommercialError({ code: '42501', message: 'PM_FORBIDDEN: cm_rfis 1234 not found in org 99' });
    expect(f.status).toBe(403);
    expect(f.body.error).not.toMatch(/1234|org 99/);
    expect(mapCommercialError({ code: '42501', message: 'PM_SOD_VIOLATION: preparer' }, 'commitment').body.error).toMatch(/someone else/);
    // security review: waiver evidence and the verify-here gate read in plain words
    expect(mapCommercialError({ code: 'P0001', message: 'PRECONDITION_WAIVER_DOCUMENT: attach the signed waiver (or complete it by e-sign) before verifying' }))
      .toEqual({ status: 422, body: { error: 'Attach the signed waiver (or complete it by e-sign) before verifying.', code: 'PRECONDITION_WAIVER_DOCUMENT' } });
    expect(mapCommercialError({ code: '42501', message: 'PM_WAIVER_VERIFY_HERE: verify the lien waiver from Compliance; it checks the signed form first' })).toMatchObject({ status: 403, body: { code: 'PM_WAIVER_VERIFY_HERE' } });
  });

  it('route bodies validate before the database sees them', () => {
    expect(ChangeEventCreate.safeParse({ jobId: '00000000-0000-4000-8000-000000000001', title: '' }).success).toBe(false);
    expect(ChangeEventCreate.parse({ jobId: '00000000-0000-4000-8000-000000000001', title: 'Soffit' })).toMatchObject({ sourceType: 'FIELD', scope: 'TBD', romRevenueCents: null });
    expect(PayAppAction.safeParse({ op: 'certify', architect: '', certifiedCents: 1 }).success).toBe(false);
    expect(SubPayAppAction.safeParse({ op: 'reject', note: '' }).success).toBe(false);
    expect(RfiCreate.safeParse({ jobId: '00000000-0000-4000-8000-000000000001', subject: 'x', question: 'y', ballEmail: 'nope' }).success).toBe(false);
    expect(TmCreate.safeParse({ jobId: '00000000-0000-4000-8000-000000000001', workDate: '2026-10-25', description: 'x', lines: [{ kind: 'LABOR', hours_st: 30 }] }).success).toBe(false);
    expect(DailyLogAction.safeParse({ op: 'amend', reason: '', entry: { kind: 'NOTE' } }).success).toBe(false);
    expect(DailyLogAction.safeParse({ op: 'entry', entry: { kind: 'DELAY', cause: 'ALIENS' } }).success).toBe(false);
  });

  it('screen helpers: dollars, days, due text', () => {
    expect([parseDollars('12,500'), parseDollars('$12500.5'), parseDollars('abc'), parseDollars('')]).toEqual([1250000, 1250050, null, null]);
    expect([dollarsText(1250000), dollarsText(1250050), dollarsText(null)]).toEqual(['12500', '12500.50', '']);
    expect([daysSince('2026-10-20', '2026-10-25'), daysSince(null, '2026-10-25')]).toEqual([5, null]);
    expect([dueText('2026-10-24', '2026-10-25'), dueText('2026-10-25', '2026-10-25'), dueText('2026-10-27', '2026-10-25')]).toEqual(['1 day late', 'due today', 'due in 2 days']);
  });
});
