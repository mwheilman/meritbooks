import { describe, expect, it } from 'vitest';
import { DEFAULT_VOCAB, compilePlan } from '@meritbooks/industry-packs';
import type { Vocabulary } from '@/lib/pm/vocab';
import {
  ITEM_NEXT, ITEM_STATUS, WO_STATUS, creatableKinds, isDealerVocab, repairOrderTerm, woBand, woKindLabel, woVocab,
} from '@/lib/pm/ops/labels';
import { opsErrorCopy } from '@/lib/pm/ops/errors';

const LOC = 'loc_00000000-0000-0000-0000-000000000001';
function packVocab(pack: string): Vocabulary {
  const plan = compilePlan({ pack, locationId: LOC, includeSample: false });
  return { ...DEFAULT_VOCAB, ...plan.vocabulary } as Vocabulary;
}

describe('repair-order vocabulary', () => {
  const dealer = packVocab('equipment_dealer');
  const field = packVocab('field_service');
  const flooring = packVocab('flooring');

  it('a dealer works in repair orders, not "RO lines"', () => {
    expect(isDealerVocab(dealer)).toBe(true);
    expect(woVocab(dealer)).toEqual({ one: 'Repair order', many: 'Repair orders', dealer: true });
    expect(woKindLabel('REPAIR_ORDER', dealer)).toBe('Repair order');
    expect(repairOrderTerm(dealer)).toBe('Repair order');
    expect(creatableKinds('equipment_dealer')[0]).toBe('REPAIR_ORDER');
  });
  it('field service says visits and flooring says install tickets', () => {
    expect(isDealerVocab(field)).toBe(false);
    expect(woVocab(field)).toMatchObject({ one: 'Visit', many: 'Visits', dealer: false });
    expect(woVocab(flooring)).toMatchObject({ one: 'Install ticket', many: 'Install tickets' });
    expect(creatableKinds('flooring')[0]).toBe('MEASURE');
  });
  it('outside a dealer pack a repair order is still called one', () => {
    expect(woKindLabel('REPAIR_ORDER', field)).toBe('Repair order');
    expect(woKindLabel('MAINTENANCE_VISIT', field)).toBe('Maintenance visit');
    expect(woKindLabel('PDI', dealer)).toBe('Pre-delivery inspection');
  });
  it('default vocabulary is neutral', () => {
    expect(woVocab(DEFAULT_VOCAB as Vocabulary).dealer).toBe(false);
  });
});

describe('work-order bands', () => {
  it('places every status in one queue band', () => {
    expect(woBand('NEW')).toBe('new');
    expect(woBand('SCHEDULED')).toBe('scheduled');
    expect(woBand('DISPATCHED')).toBe('scheduled');
    expect(woBand('IN_PROGRESS')).toBe('progress');
    expect(woBand('ON_HOLD')).toBe('progress');
    expect(woBand('COMPLETE')).toBe('complete');
    expect(woBand('CLOSED')).toBe('closed');
    expect(woBand('CANCELLED')).toBe('closed');
    for (const s of Object.keys(WO_STATUS)) expect(WO_STATUS[s as keyof typeof WO_STATUS].word.length).toBeGreaterThan(0);
  });
  it('every procurement move lands on a status with a word', () => {
    for (const [from, tos] of Object.entries(ITEM_NEXT)) {
      expect(ITEM_STATUS[from as keyof typeof ITEM_STATUS]).toBeDefined();
      for (const t of tos) expect(ITEM_STATUS[t]).toBeDefined();
    }
  });
});

describe('ops error sentences', () => {
  it('turns a double booking into a 409 that names the clash', () => {
    const e = opsErrorCopy({ code: '23P01', message: 'PM_DISPATCH_OVERLAP: technician 4f1c… is already booked on WO-1042 in that window' });
    expect(e).toMatchObject({ status: 409, code: 'PM_DISPATCH_OVERLAP' });
    expect(e?.error).toBe('That technician is already booked on WO-1042 at that time. Pick another time or technician.');
  });
  it('names missing skills from the skill list', () => {
    const e = opsErrorCopy({ code: '22023', message: 'PM_SKILL_MISMATCH: assigned technicians lack epa_608, gas_line' }, { epa_608: 'EPA 608' });
    expect(e?.error).toBe('The technician does not hold EPA 608, gas line. Pick someone who does, or assign anyway.');
  });
  it('keeps detail tokens readable and hides record ids', () => {
    const e = opsErrorCopy({ code: '22023', message: 'PM_DRAW_OVER_BUDGET: line 3 (0b8a2c4e-1111-4222-8333-944445555666) would reach 105%' });
    expect(e?.error).toBe('A line would draw past its loan budget: line 3 (that record) would reach 105%.');
  });
  it('maps a locked state (55000) without a token', () => {
    expect(opsErrorCopy({ code: '55000', message: 'measure is final' })).toMatchObject({ status: 422, code: 'LOCKED', error: 'Measure is final.' });
  });
  it('leaves everything else to the shared mapper', () => {
    expect(opsErrorCopy({ code: '42501', message: 'permission denied for table work_orders' })).toBeNull();
  });
});
