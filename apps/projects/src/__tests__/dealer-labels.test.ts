/**
 * Dealer words: the equipment_dealer pack's vocabulary and KPIs as the app sees them, the Store
 * rail group's gating, status marks, and the sentences for 1109 error tokens.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_VOCAB, compilePlan, getMetric, resolveManifest } from '@meritbooks/industry-packs';
import { railNav, isDealerNav, type NavInput } from '@/lib/nav';
import type { Vocabulary } from '@/lib/pm/vocab';
import { isDealerVocab, woVocab } from '@/lib/pm/ops/labels';
import {
  DEAL_BANDS, UNIT_NEXT, agingMark, checklistMissing, dealEditable, isDealerPack, outboxMark, roTerm, unitMoves, unitTitle,
} from '@/lib/pm/dealer/labels';
import { dealerErrorCopy, parseMarginFloor, parsePayoffUnits, roleWords } from '@/lib/pm/dealer/errors';

const LOC = 'loc_00000000-0000-0000-0000-000000000001';
function packVocab(pack: string): Vocabulary {
  const plan = compilePlan({ pack, locationId: LOC, includeSample: false });
  return { ...DEFAULT_VOCAB, ...plan.vocabulary } as Vocabulary;
}

describe('equipment_dealer pack, as the app reads it', () => {
  const v = packVocab('equipment_dealer');
  it('speaks in repair orders, sublet vendors and parts POs', () => {
    expect(isDealerVocab(v)).toBe(true);
    expect(roTerm(v)).toBe('Repair order');
    expect(woVocab(v)).toEqual({ one: 'Repair order', many: 'Repair orders', dealer: true });
    expect(v.subcontractors).toBe('Sublet vendors');
    expect(v.commitments).toBe('Parts and sublet POs');
    expect(v.pm).toBe('Service manager');
    expect(isDealerVocab(packVocab('field_service'))).toBe(false);
  });
  it('runs the whole store: version bumped, store KPIs present and defined', () => {
    const m = resolveManifest('equipment_dealer');
    expect(m.version).toBe('1.1.0');
    expect(m.name).toBe('Equipment dealer');
    const metrics = m.kpis.map((k) => k.metric);
    for (const key of ['unit_turn_days', 'aged_inventory_count_over_180', 'deal_gross_avg_cents', 'parts_fill_rate_pct', 'rental_utilization_pct']) {
      expect(metrics).toContain(key);
      expect(getMetric(key)?.definition.length).toBeGreaterThan(20);
    }
    expect(getMetric('unit_turn_days')).toMatchObject({ unit: 'days', goodDirection: 'down' });
    expect(getMetric('rental_utilization_pct')).toMatchObject({ unit: 'pct', goodDirection: 'up' });
    expect(m.fieldDefs.some((f) => f.object === 'asset' && f.key === 'engine_serial')).toBe(true);
    expect(isDealerPack('equipment_dealer')).toBe(true);
    expect(isDealerPack('field_service')).toBe(false);
  });
});

describe('Store rail group', () => {
  const base: NavInput = { context: 'client', vocab: { ...DEFAULT_VOCAB }, modules: [], booksPresent: true, companyCount: 1 };
  const hrefs = (i: Partial<NavInput>) => railNav({ ...base, ...i }).flatMap((g) => [...g.items, ...g.more].map((x) => x.href));
  const STORE = ['/stock', '/deals', '/parts', '/rentals', '/warranty'];

  it('shows for a dealer (by pack, archetype or vocabulary)', () => {
    expect(hrefs({ packKeys: ['equipment_dealer'] })).toEqual(expect.arrayContaining(STORE));
    expect(hrefs({ archetypes: ['dealer_service'] })).toEqual(expect.arrayContaining(STORE));
    expect(hrefs({ vocab: packVocab('equipment_dealer') })).toEqual(expect.arrayContaining(STORE));
    expect(isDealerNav({ vocab: packVocab('equipment_dealer') })).toBe(true);
  });
  it('is absent for everyone else, and outside a company', () => {
    const h = hrefs({ vocab: packVocab('field_service'), packKeys: ['field_service'], modules: ['dispatch', 'assets'] });
    for (const s of STORE) expect(h).not.toContain(s);
    const ws = hrefs({ context: 'workspace', packKeys: ['equipment_dealer'] });
    for (const s of STORE) expect(ws).not.toContain(s);
  });
  it('leaves /units (development lots) alone', () => {
    expect(hrefs({ packKeys: ['equipment_dealer'] }).filter((h) => h === '/stock')).toHaveLength(1);
  });
});

describe('store marks', () => {
  it('unit moves mirror set_dealer_unit_status; a deal hold is released by the deal', () => {
    expect(UNIT_NEXT.IN_STOCK).not.toContain('PDI'); // PDI opens through open_unit_pdi
    expect(unitMoves('IN_STOCK', null)).toContain('DEMO');
    expect(unitMoves('ON_HOLD', 'deal-1')).toEqual([]);
    expect(unitMoves('ON_HOLD', null)).toEqual(['IN_STOCK']);
    expect(unitMoves('DELIVERED', null)).toEqual([]);
    expect(unitMoves(null, null)).toEqual([]);
  });
  it('aging marks warn at 91 days and alarm past 180', () => {
    expect(agingMark(null)).toBeNull();
    expect(agingMark(1)?.word).toBe('1 day');
    expect(agingMark(30)).toMatchObject({ word: '30 days', pip: 'track' });
    expect(agingMark(120)?.pip).toBe('soft');
    expect(agingMark(200)).toMatchObject({ word: '200 days', pip: 'risk' });
    expect(agingMark(400)?.pip).toBe('overdue');
  });
  it('deal lines are editable while quoted or written; six bands cover the pipeline', () => {
    expect(dealEditable('QUOTE')).toBe(true);
    expect(dealEditable('WRITTEN')).toBe(true);
    expect(dealEditable('APPROVED')).toBe(false);
    expect(DEAL_BANDS.map((b) => b.value)).toEqual(['QUOTE', 'WRITTEN', 'APPROVED', 'FUNDED', 'DELIVERED', 'UNWOUND']);
  });
  it('a held event says why it waits; the seam never reads as broken', () => {
    expect(outboxMark('HELD').word).toBe('Held until Merit Books turns on dealer posting');
    expect(outboxMark('REJECTED').word).toBe('Rejected by Merit Books');
    expect(outboxMark('SUPPRESSED', 'SAMPLE').word).toBe('Sample record, not sent');
  });
  it('names a unit by year, make and model', () => {
    expect(unitTitle({ model_year: 2026, make: 'Kubota', model: 'BX2380' })).toBe('2026 Kubota BX2380');
    expect(checklistMissing([
      { key: 'a', label: 'A', required: true, done: true },
      { key: 'b', label: 'B', required: true, done: false },
      { key: 'c', label: 'C', required: false },
    ]).map((x) => x.key)).toEqual(['b']);
  });
});

describe('1109 error tokens in plain words', () => {
  const floor = 'PM_DEAL_MARGIN_FLOOR: front gross 120000 cents (6.15% of sale) is below the floor (8.00% / 0 cents); needs role {ops_manager}, approver has pm';
  it('parses and words the margin floor', () => {
    expect(parseMarginFloor(floor.slice('PM_DEAL_MARGIN_FLOOR: '.length))).toMatchObject({ frontCents: 120_000, pct: '6.15%', floorPct: '8.00%', minCents: 0, roles: '{ops_manager}', has: 'pm' });
    const c = dealerErrorCopy({ code: '42501', message: floor });
    expect(c?.status).toBe(403);
    expect(c?.error).toMatch(/^Front gross 1,200\.00 \(6\.15% of sale\) is below the 8\.00% floor\. A floor override needs operations manager; you are project manager\.$/);
  });
  it('lists the floored units on a payoff error', () => {
    const detail = 'floor-plan payoff due on delivery (sold out of trust if not paid): [{"stock_number": "N26-0004", "payoff_cents": 1840000, "payoff_due_on": "2026-11-01"}]; acknowledge to deliver';
    expect(parsePayoffUnits(detail)).toEqual([{ stock_number: 'N26-0004', serial_number: null, payoff_cents: 1_840_000, payoff_due_on: '2026-11-01' }]);
    expect(dealerErrorCopy({ code: 'P0001', message: `PM_DELIVERY_PAYOFF_DUE: ${detail}` })?.error).toContain('N26-0004 18,400.00');
    expect(parsePayoffUnits('no list')).toEqual([]);
  });
  it('words the checklist, a rental overlap and a separation-of-duties stop', () => {
    expect(dealerErrorCopy({ code: 'P0001', message: 'PM_DELIVERY_CHECKLIST_INCOMPLETE: deal DL-1 still needs: pdi_complete' })?.error).toMatch(/^Finish the delivery checklist first: /);
    const o = dealerErrorCopy({ code: '23P01', message: 'PM_RENTAL_OVERLAP: unit already reserved' });
    expect(o).toMatchObject({ status: 409, code: 'PM_RENTAL_OVERLAP' });
    expect(o?.error).toMatch(/already reserved or out/);
    expect(dealerErrorCopy({ code: '42501', message: 'PM_SOD_VIOLATION: approver wrote the deal' })?.error).toMatch(/cannot desk it/);
  });
  it('keeps detail for detail tokens and hides ids', () => {
    const c = dealerErrorCopy({ code: 'P0001', message: 'PM_UNIT_NOT_AVAILABLE: unit 11111111-1111-4111-8111-111111111111 is SOLD' });
    expect(c?.error).toBe('Unit that record is SOLD.');
    expect(dealerErrorCopy({ code: 'P0001', message: 'PM_SOMETHING_ELSE: x' })).toBeNull();
    expect(dealerErrorCopy({ code: 'P0001', message: 'plain message' })).toBeNull();
  });
  it('turns role arrays into words', () => {
    expect(roleWords('{ops_manager,owner}')).toBe('operations manager or owner');
    expect(roleWords('')).toBe('a manager role');
  });
});
