import { describe, expect, it } from 'vitest';
import {
  afterHoursPrice, changedPrice, ladderMarkup, materialSell, memberPrice, monthlyPayment, optionMoney, priceItem, roundRule, servicePrice,
  DEFAULT_PRICE_SETTINGS, type MarkupTier,
} from '@/lib/fieldservice/pricing';
import { centsCell, dollarsToCentsText, mapHeader, parseCsv, parsePricebookCsv, pctText, toCsv } from '@/lib/fieldservice/csv';
import { cellState, disclosuresFor, duplicateOf, fmtPhone, isoDow, missedDisclosures, missingAnswers, normPhone, zoneForZip } from '@/lib/fieldservice/booking';
import { fsErrorCopy } from '@/lib/fieldservice/errors';
import { pricebookOpTouchesCost } from '@/lib/fieldservice/cost-guard';
import { FORM_MAX_MS, checkFormToken, clientIp, honeypotTripped, issueFormToken, verifyChallenge } from '@/lib/fieldservice/widget-guard';
import type { BookingJobTypeRow, CallerPop } from '@/lib/fieldservice/types';

const LADDER: MarkupTier[] = [
  { upToCents: 1000, markupPct: 2 }, { upToCents: 5000, markupPct: 1.25 }, { upToCents: 25000, markupPct: 0.8 },
  { upToCents: 100000, markupPct: 0.55 }, { upToCents: null, markupPct: 0.4 },
];

describe('price formulas (FS-45) — same numbers as migration 1117', () => {
  it('rounding rules round up, never below the formula', () => {
    expect(roundRule(28740, 'NONE')).toBe(28740);
    expect(roundRule(28740, 'WHOLE')).toBe(28800);
    expect(roundRule(28740, 'FIVE')).toBe(29000);
    expect(roundRule(28740, 'NINE')).toBe(28900);
    expect(roundRule(28900, 'NINE')).toBe(28900);
    expect(roundRule(29001, 'NINE')).toBe(29900);
    expect(roundRule(0, 'NINE')).toBe(0);
  });
  it('the ladder picks the smallest tier that covers the unit cost', () => {
    expect(ladderMarkup(1000, LADDER)).toBe(2);
    expect(ladderMarkup(1001, LADDER)).toBe(1.25);
    expect(ladderMarkup(999999, LADDER)).toBe(0.4);
    expect(ladderMarkup(500, [])).toBe(0);
  });
  it('service task: 0.75 h × $95 ÷ (1 − 55 %) + capacitor $18.50 × 2.25 → $199.96 → NINE → $209', () => {
    expect(materialSell(1, 1850, LADDER)).toBe(4163);
    expect(servicePrice(0.75, 9500, 0.55, 4163, 'NONE')).toBe(19996);
    expect(servicePrice(0.75, 9500, 0.55, 4163, 'NINE')).toBe(20900);
    const r = priceItem({ kind: 'SERVICE', taskHours: 0.75, materials: [{ qty: 1, unitCostCents: 1850 }] }, DEFAULT_PRICE_SETTINGS, LADDER);
    expect(r).toMatchObject({ priceCents: 20900, memberPriceCents: 17900, afterHoursPriceCents: 31900, laborCostCents: 7125, materialCostCents: 1850, costCents: 8975 });
    expect(r.marginPct).toBe(0.5706);
  });
  it('materials, equipment, fees and locked prices', () => {
    expect(priceItem({ kind: 'MATERIAL', costCents: 2000 }, DEFAULT_PRICE_SETTINGS, LADDER).priceCents).toBe(4900); // 20 × 2.25 = 45 → $49
    expect(priceItem({ kind: 'EQUIPMENT', costCents: 350000 }, DEFAULT_PRICE_SETTINGS, LADDER).priceCents).toBe(538900); // 3500 ÷ 0.65 = 5384.62 → $5,385 → $5,389
    expect(priceItem({ kind: 'FEE', currentPriceCents: 8900 }, DEFAULT_PRICE_SETTINGS, LADDER).priceCents).toBe(8900);
    expect(priceItem({ kind: 'SERVICE', taskHours: 3, priceLocked: true, currentPriceCents: 12345 }, DEFAULT_PRICE_SETTINGS, LADDER).priceCents).toBe(12345);
  });
  it('member never exceeds the regular price; after hours multiplies; percent change rounds', () => {
    expect(memberPrice(20900, 0.15, 'NINE')).toBe(17900);
    expect(memberPrice(900, 0.01, 'NINE')).toBe(900);
    expect(afterHoursPrice(20900, 1.5, 'NINE')).toBe(31900);
    expect(changedPrice(20900, 0.1, 'NINE')).toBe(23900); // 229.90 → $230 → $239
    expect(changedPrice(20900, -0.1, 'NONE')).toBe(18810);
  });
  it('half-up ties match SQL div(2n + d, 2d)', () => {
    // 0.5 h × $1.00 ÷ (1 − 0) = 50 cents exactly; 0.01 h × $50 = 50 cents
    expect(servicePrice(0.01, 5000, 0, 0, 'NONE')).toBe(50);
    expect(materialSell(0.5, 1, [])).toBe(1); // 0.5 → 1 (half up)
    expect(materialSell(1.5, 1, [])).toBe(2);
  });
  it('monthly payment: amortized at 1e18 fixed point, 0 % = amount ÷ months', () => {
    expect(monthlyPayment(1_200_000, 0.0999, 60)).toBe(25491);
    expect(monthlyPayment(120_000, 0, 12)).toBe(10000);
    expect(monthlyPayment(0, 0.1, 12)).toBe(0);
  });
  it('option money: member price, rebate, monthly', () => {
    const m = optionMoney(500000, 450000, 30000, true, { apr: 0, termMonths: 12 });
    expect(m).toEqual({ regularCents: 500000, memberCents: 450000, rebateCents: 30000, netCents: 420000, monthlyCents: 35000 });
    expect(optionMoney(1000, 900, 2000, false, null)).toMatchObject({ netCents: 0, monthlyCents: null });
  });
});

describe('price-book spreadsheet round trip (FS-46)', () => {
  it('parses what Excel writes: BOM, quotes, embedded commas / quotes / newlines, CRLF', () => {
    const rows = parseCsv('﻿code,name\r\nA,"Cap, 45/5 ""dual"""\r\nB,"two\nlines"\r\n');
    expect(rows).toEqual([['code', 'name'], ['A', 'Cap, 45/5 "dual"'], ['B', 'two\nlines']]);
  });
  it('export → import keeps every value', () => {
    const csv = toCsv(['code', 'name', 'kind', 'task_hours', 'cost', 'price', 'price_locked', 'materials'],
      [['HV-CAP', 'Replace run capacitor, 45/5', 'SERVICE', 0.75, '', centsCell(20900), 'no', 'M-CAP-4505:1'], ['FEE-TRIP', 'Trip "charge"', 'FEE', '', '', centsCell(4900), 'yes', '']]);
    const back = parsePricebookCsv(csv);
    expect(back.problems).toEqual([]);
    expect(back.rows).toEqual([
      { code: 'HV-CAP', name: 'Replace run capacitor, 45/5', kind: 'SERVICE', task_hours: '0.75', price_cents: '20900', price_locked: false, materials: 'M-CAP-4505:1' },
      { code: 'FEE-TRIP', name: 'Trip "charge"', kind: 'FEE', price_cents: '4900', price_locked: true },
    ]);
  });
  it('maps another system’s headers and amounts', () => {
    const m = mapHeader(['SKU', 'Description', 'Unit Cost', 'Sell Price', 'Labor Hours', 'Member Price']);
    expect(m).toMatchObject({ code: 0, name: 1, cost: 2, price: 3, task_hours: 4, member_price: 5 });
    expect(dollarsToCentsText('$1,234.50')).toBe(123450);
    expect(dollarsToCentsText('(12.00)')).toBe(-1200);
    expect(dollarsToCentsText('12.345')).toBe(1235);
    expect(Number.isNaN(dollarsToCentsText('abc'))).toBe(true);
    expect(pctText('45%')).toBe(0.45);
    expect(pctText('0.45')).toBe(0.45);
  });
  it('flags bad lines with their spreadsheet line number and needs code + name', () => {
    const r = parsePricebookCsv('code,name,cost\nA,Alpha,12.00\nB,Beta,twelve\n');
    expect(r.rows).toHaveLength(1);
    expect(r.problems).toEqual([{ line: 3, error: 'cost "twelve" is not an amount' }]);
    expect(parsePricebookCsv('foo,bar\n1,2\n').problems[0]?.line).toBe(1);
  });
});

const JT: Pick<BookingJobTypeRow, 'script' | 'diagnostic_fee_cents' | 'after_hours_fee_cents' | 'member_waives_diagnostic'> = {
  diagnostic_fee_cents: 8900, after_hours_fee_cents: 9900, member_waives_diagnostic: true,
  script: {
    questions: [{ id: 'age', prompt: 'Age?', kind: 'choice', options: ['new', 'old'], required: true }, { id: 'warranty', prompt: 'Warranty?', kind: 'yesno' }],
    disclosures: [{ id: 'diagnostic', fee: 'diagnostic', text: 'Diagnostic fee {fee}.' }, { id: 'after_hours', fee: 'after_hours', text: 'After hours {after_hours_fee}.' }],
  },
};

describe('booking rules in the browser (FS-03 / FS-04 / FS-15)', () => {
  it('required script answers and fee disclosures', () => {
    expect(missingAnswers(JT.script, {})).toEqual(['age']);
    expect(missingAnswers(JT.script, { age: 'old' })).toEqual([]);
    const d = disclosuresFor(JT, { afterHours: false, member: false });
    expect(d.map((x) => x.rendered)).toEqual(['Diagnostic fee $89.00.']);
    expect(disclosuresFor(JT, { afterHours: true, member: true }).map((x) => x.id)).toEqual(['after_hours']);
    expect(missedDisclosures(d, [])).toEqual(['diagnostic']);
    expect(missedDisclosures(d, ['diagnostic'])).toEqual([]);
  });
  it('capacity cell states say it in words', () => {
    expect(cellState({ limited: false, jobs_left: null, minutes_left: null, is_open: true })).toBe('unlimited');
    expect(cellState({ limited: false, jobs_left: null, minutes_left: null, is_open: true }, true)).toBe('closed');
    expect(cellState({ limited: true, jobs_left: 0, minutes_left: null, is_open: false })).toBe('full');
    expect(cellState({ limited: true, jobs_left: 1, minutes_left: null, is_open: true })).toBe('tight');
    expect(cellState({ limited: true, jobs_left: 3, minutes_left: null, is_open: true })).toBe('open');
  });
  it('duplicate open job at the site; zone from zip; phone and weekday helpers', () => {
    const pop: CallerPop = { phone: null, matches: [], tracking_campaign: null, open_work: [
      { work_order_id: 'w1', number: 'WO-1', summary: 'No cool', status: 'SCHEDULED', site_id: 's1', service_day: null, kind: 'SERVICE' },
      { work_order_id: 'w2', number: 'WO-2', summary: 'Tune-up', status: 'NEW', site_id: 's2', service_day: null, kind: 'MAINTENANCE_VISIT' },
    ] };
    expect(duplicateOf(pop, 's1')?.number).toBe('WO-1');
    expect(duplicateOf(pop, 's2')).toBeNull();
    expect(zoneForZip([{ id: 'z', zips: ['50310'], is_active: true }], '50310-1234')).toBe('z');
    expect(zoneForZip([{ id: 'z', zips: ['50310'], is_active: false }], '50310')).toBeNull();
    expect(normPhone('+1 (515) 555-0101')).toBe('5155550101');
    expect(fmtPhone('5155550101')).toBe('(515) 555-0101');
    expect(isoDow('2026-10-26')).toBe(1);
    expect(isoDow('2026-11-01')).toBe(7);
  });
});

describe('plain-language errors for 1117 tokens', () => {
  it('capacity and duplicates are 409 with the database sentence', () => {
    expect(fsErrorCopy({ code: '53400', message: 'PM_FS_CAPACITY_FULL: 8–10 am is full for HVAC Service on 2026-10-27 (2 of 2 booked)' }))
      .toEqual({ status: 409, code: 'PM_FS_CAPACITY_FULL', error: '8–10 am is full for HVAC Service on 2026-10-27 (2 of 2 booked).' });
    expect(fsErrorCopy({ code: '23505', message: 'PM_FS_DUPLICATE_OPEN_JOB: WO-2026-00012 is already open at this location — open it, or book anyway with a reason' })?.status).toBe(409);
    expect(fsErrorCopy({ code: '42501', message: 'FS_WIDGET_UNKNOWN: this booking link is not active' })).toMatchObject({ status: 404 });
    expect(fsErrorCopy({ code: '22023', message: 'PM_INVALID: x' })).toBeNull();
  });
});

describe('widget hardening errors (security review)', () => {
  it('limit, lead time and server key map to plain answers', () => {
    expect(fsErrorCopy({ code: '53400', message: 'FS_WIDGET_LIMIT: we already have your request — we will call you to confirm' }))
      .toEqual({ status: 429, code: 'FS_WIDGET_LIMIT', error: 'We already have your request — we will call you to confirm.' });
    expect(fsErrorCopy({ code: '22023', message: "FS_WIDGET_TOO_SOON: online booking needs 4 hours' notice — pick a later time or call us" })?.status).toBe(422);
    expect(fsErrorCopy({ code: '42501', message: 'FS_WIDGET_KEY: online booking must go through the booking page' }))
      .toEqual({ status: 403, code: 'FS_WIDGET_KEY', error: 'Online booking is unavailable right now. Please call us.' });
    expect(fsErrorCopy({ code: '53400', message: 'FS_WIDGET_BUSY: online booking is busy — please call us' })?.status).toBe(429);
    expect(fsErrorCopy({ code: '55000', message: "FS_WIDGET_NOT_SET_UP: online booking isn't set up yet — please call us" }))
      .toEqual({ status: 503, code: 'FS_WIDGET_NOT_SET_UP', error: 'Online booking isn’t set up yet. Please call us.' });
  });
});

describe('widget front door (security review)', () => {
  const H = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
  it('client IP is the first forwarded hop, validated', () => {
    expect(clientIp(H({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientIp(H({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1');
    expect(clientIp(H({ 'x-forwarded-for': "1.2.3.4'; drop table x" }))).toBeNull();
    expect(clientIp(H({}))).toBeNull();
  });
  it('honeypot trips on any filled value', () => {
    expect(honeypotTripped(undefined)).toBe(false);
    expect(honeypotTripped('')).toBe(false);
    expect(honeypotTripped('  ')).toBe(false);
    expect(honeypotTripped('http://spam')).toBe(true);
    expect(honeypotTripped(1)).toBe(true);
  });
  it('form token: signed, too fast, expired, forged, missing', () => {
    const t0 = 1_790_000_000_000;
    const signed = issueFormToken(t0, 's3cret');
    expect(signed).toMatch(/^\d+\.[0-9a-f]{32}$/);
    expect(checkFormToken(signed, t0 + 5_000, 's3cret')).toEqual({ ok: true });
    expect(checkFormToken(signed, t0 + 1_000, 's3cret')).toEqual({ ok: false, reason: 'too_fast' });
    expect(checkFormToken(signed, t0 + FORM_MAX_MS + 1, 's3cret')).toEqual({ ok: false, reason: 'expired' });
    expect(checkFormToken(signed, t0 + 5_000, 'other')).toEqual({ ok: false, reason: 'forged' });
    expect(checkFormToken(String(t0 - 10_000), t0, 's3cret')).toEqual({ ok: false, reason: 'forged' });
    expect(checkFormToken(`${t0 - 10_000}.${'0'.repeat(32)}`, t0, 's3cret')).toEqual({ ok: false, reason: 'forged' });
    expect(checkFormToken(undefined, t0, 's3cret')).toEqual({ ok: false, reason: 'missing' });
    // Unsigned mode (no secret configured) still enforces timing.
    expect(checkFormToken(issueFormToken(t0, null), t0 + 4_000, null)).toEqual({ ok: true });
    expect(checkFormToken(issueFormToken(t0, null), t0 + 100, null)).toEqual({ ok: false, reason: 'too_fast' });
  });
  it('challenge: disabled until a secret is set, then fails closed', async () => {
    const calls: string[] = [];
    const ok = async (url: string, init: { body: URLSearchParams }) => { calls.push(`${url}|${init.body.get('remoteip')}`); return { ok: true, json: async () => ({ success: true }) }; };
    const no = async () => ({ ok: true, json: async () => ({ success: false }) });
    const down = async () => { throw new Error('network'); };
    expect(await verifyChallenge(undefined, null, {}, ok)).toEqual({ ok: true, mode: 'disabled' });
    expect(calls).toHaveLength(0);
    expect(await verifyChallenge('tok-1234567890', '203.0.113.7', { secret: 'k', url: 'https://verify.test' }, ok)).toEqual({ ok: true, mode: 'verified' });
    expect(calls).toEqual(['https://verify.test|203.0.113.7']);
    expect(await verifyChallenge('tok-1234567890', null, { secret: 'k' }, no)).toEqual({ ok: false, mode: 'failed' });
    expect(await verifyChallenge('tok-1234567890', null, { secret: 'k' }, down)).toEqual({ ok: false, mode: 'failed' });
    expect(await verifyChallenge(undefined, null, { secret: 'k' }, ok)).toEqual({ ok: false, mode: 'failed' });
  });
});

describe('margin targets follow the cost rule (security review L)', () => {
  it('ops that set a margin or cost need financials', () => {
    expect(pricebookOpTouchesCost({ op: 'settings' })).toBe(true);
    expect(pricebookOpTouchesCost({ op: 'bulk', mode: 'TARGET_GM' })).toBe(true);
    expect(pricebookOpTouchesCost({ op: 'bulk', mode: 'PCT' })).toBe(false);
    expect(pricebookOpTouchesCost({ op: 'import', rows: [{ target_gm_pct: '.45' }] })).toBe(true);
    expect(pricebookOpTouchesCost({ op: 'import', rows: [{ cost_cents: '100' }] })).toBe(true);
    expect(pricebookOpTouchesCost({ op: 'import', rows: [{}] })).toBe(false);
    expect(pricebookOpTouchesCost({ op: 'reprice' })).toBe(false);
  });
});
