/**
 * scanDealerControls end to end over an in-memory database: SOT + curtailment
 * findings are queued once (insert), a re-run queues nothing (idempotent), and
 * paying the note off / paying the curtailment EXPIRES both (AC 6 "paying off
 * clears it"). Also: a client with the pack off is never scanned, a failing read
 * never throws, and nothing but ai_decisions (+ the AI action trail) is written.
 */
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@/lib/dealer/types';
import { memorySupabase, type MemTables } from '@/test/memory-supabase';
import { scanDealerControls, DEALER_DETECTORS } from './index';

const ORG = 'org-1';
const LOC = 'loc-1';
const OFF = 'loc-off';
const ASOF = '2026-10-20';

function seed(): MemTables {
  return {
    dealer_pack_settings: [
      { ...defaultSettings(ORG, LOC), id: 's1', enabled: true },
      { ...defaultSettings(ORG, OFF), id: 's2', enabled: false },
    ],
    dealer_units: [
      { id: 'u1', org_id: ORG, location_id: LOC, serial_number: '4471', status: 'SOLD', warranty_registered_date: null, source: 'LENDER', cost_cents: 1_040_000 },
      { id: 'u2', org_id: ORG, location_id: LOC, serial_number: '5502', status: 'IN_STOCK', warranty_registered_date: null, source: 'LENDER', cost_cents: 800_000 },
      { id: 'u9', org_id: ORG, location_id: OFF, serial_number: '9999', status: 'SOLD', warranty_registered_date: null, source: 'LENDER', cost_cents: 1 },
    ],
    floor_plan_notes: [
      // Sold 2026-10-08, payoff due the same day, grace 2 → CRITICAL by 10-20.
      { id: 'n1', org_id: ORG, location_id: LOC, line_id: 'l1', unit_id: 'u1', status: 'SOLD_UNPAID', principal_balance_cents: 900_000, sold_date: '2026-10-08', payoff_due_date: '2026-10-08', lender_invoice_number: 'INV-1', original_principal_cents: 1_000_000, floored_date: '2026-04-01', program_id: null },
      { id: 'n2', org_id: ORG, location_id: LOC, line_id: 'l1', unit_id: 'u2', status: 'OPEN', principal_balance_cents: 800_000, sold_date: null, payoff_due_date: null, lender_invoice_number: 'INV-2', original_principal_cents: 800_000, floored_date: '2026-10-01', program_id: null },
      { id: 'n9', org_id: ORG, location_id: OFF, line_id: 'l9', unit_id: 'u9', status: 'SOLD_UNPAID', principal_balance_cents: 1, sold_date: '2026-01-01', payoff_due_date: '2026-01-01', lender_invoice_number: 'INV-9', original_principal_cents: 1, floored_date: '2025-01-01', program_id: null },
    ],
    floor_plan_curtailments: [
      { id: 'c1', org_id: ORG, location_id: LOC, note_id: 'n2', sequence: 1, due_date: '2026-10-24', amount_cents: 80_000, status: 'DUE' },
    ],
    floor_plan_lines: [{ id: 'l1', org_id: ORG, location_id: LOC, lender_vendor_id: 'v-lender', name: 'Main line' }],
    ai_decisions: [],
  };
}

const open = (t: MemTables) => (t.ai_decisions ?? []).filter((r) => r.status === 'PROPOSED');
const keys = (t: MemTables) => open(t).map((r) => (r.proposed_output as { dedup_key: string }).dedup_key).sort();

describe('scanDealerControls', () => {
  it('queues SOT + curtailment, is idempotent, and expires both once cleared', async () => {
    const db = memorySupabase(seed());
    const first = await scanDealerControls(db.client, ORG, { asOf: ASOF });
    expect(first.errors).toBe(0);
    expect(first.clients).toBe(1);
    expect(keys(db.tables)).toEqual(['DL-1:n1', 'DL-2:c1:due']);
    expect(first.byDetector.dealer_sot).toBe(1);
    expect(first.byDetector.dealer_curtailment).toBe(1);
    expect(Object.keys(first.byDetector).sort()).toEqual(DEALER_DETECTORS.map((d) => d.key).sort());

    const sot = open(db.tables).find((r) => r.feature === 'DEALER_SOT')!;
    expect(sot.location_id).toBe(LOC);
    expect(sot.input_summary).toBe('Sold out of trust: serial 4471 · $9,000.00 unpaid 12 days');
    expect(sot.created_by_user).toBeNull();
    expect(Number(sot.confidence)).toBe(1);
    const po = sot.proposed_output as Record<string, unknown>;
    expect(po).toMatchObject({ control: 'DL-1', severity: 'CRITICAL', disposition: 'ESCALATE', amount_at_risk_cents: 900_000, href: '/dealer/floor-plan/notes/n1' });
    expect((po.subjects as Record<string, unknown>).note_id).toBe('n1');
    expect(typeof sot.clarifying_question).toBe('string');
    // AI trail
    expect((db.tables['core.action_log'] ?? []).map((r) => r.action).sort()).toEqual(['controls.dealer_curtailment.detect', 'controls.dealer_sot.detect']);

    // Re-run: nothing new, nothing expired.
    const second = await scanDealerControls(db.client, ORG, { asOf: ASOF });
    expect(second.queued).toBe(0);
    expect(second.expired).toBe(0);
    expect(open(db.tables)).toHaveLength(2);

    // Pay the note off and the curtailment → both clear.
    Object.assign(db.tables.floor_plan_notes[0], { status: 'PAID_OFF', principal_balance_cents: 0 });
    Object.assign(db.tables.floor_plan_curtailments[0], { status: 'PAID' });
    const third = await scanDealerControls(db.client, ORG, { asOf: ASOF });
    expect(third.expired).toBe(2);
    expect(open(db.tables)).toHaveLength(0);
    expect((db.tables.ai_decisions ?? []).every((r) => r.status === 'EXPIRED')).toBe(true);
  });

  it('a dismissed exception does not come back; the next severity is a new exception', async () => {
    const db = memorySupabase(seed());
    await scanDealerControls(db.client, ORG, { asOf: ASOF });
    const due = open(db.tables).find((r) => r.feature === 'DEALER_CURTAILMENT')!;
    due.status = 'REJECTED';
    await scanDealerControls(db.client, ORG, { asOf: ASOF });
    expect(keys(db.tables)).toEqual(['DL-1:n1']);
    // The due date passes → a missed (HIGH) row is queued even though "due" was dismissed.
    await scanDealerControls(db.client, ORG, { asOf: '2026-10-25' });
    expect(keys(db.tables)).toEqual(['DL-1:n1', 'DL-2:c1:missed']);
  });

  it('only scans the requested client, never one with the pack off, and only writes ai_decisions', async () => {
    const db = memorySupabase(seed());
    const r = await scanDealerControls(db.client, ORG, { asOf: ASOF, locationId: OFF });
    expect(r.clients).toBe(0);
    expect(r.queued).toBe(0);
    await scanDealerControls(db.client, ORG, { asOf: ASOF });
    expect(open(db.tables).some((x) => x.location_id === OFF)).toBe(false);
    const written = [...new Set(db.writes.map((w) => w.table))].sort();
    expect(written).toEqual(['ai_decisions', 'core.action_log']);
  });

  it('never throws: a failing read is counted and that detector does not expire anything', async () => {
    const db = memorySupabase(seed());
    await scanDealerControls(db.client, ORG, { asOf: ASOF });
    db.failOn = (table, op) => (table === 'dealer_unit_sales' && op === 'select' ? 'boom' : null);
    Object.assign(db.tables.floor_plan_curtailments[0], { status: 'PAID' });
    const r = await scanDealerControls(db.client, ORG, { asOf: ASOF });
    expect(r.errors).toBeGreaterThan(0);
    // SOT could not be evaluated → its row stays open; curtailments read fine → expired.
    expect(keys(db.tables)).toEqual(['DL-1:n1']);
  });
});
