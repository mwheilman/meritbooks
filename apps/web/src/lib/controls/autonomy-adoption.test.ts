/**
 * Autonomy Control Plane adoption — proves the exception-library detectors record
 * the ADVISORY disposition their tenant settings imply on every proposal, and that
 * the global kill switch forces BLOCKED. This is the wiring that makes the
 * per-feature dial + kill switch actually govern each AI proposal (M10 adoption).
 *
 * Two seams are exercised:
 *   1. A REAL detector end-to-end (duplicate-payments, EC-1) against a compact fake
 *      Supabase — asserts the inserted ai_decisions.proposed_output.disposition is
 *      exactly what the seeded autonomy_settings / kill switch imply. Covers the
 *      default (PROPOSE) path, the dial-up path (a detect-only control still never
 *      auto-applies), and the kill-switch path (BLOCKED).
 *   2. The shared governance seam (loadAutonomyGovernance → decideDisposition) for a
 *      SECOND feature key (ANOMALOUS_JE) — proves AUTO/ESCALATE map from settings.
 *
 * NOTE: adoption is ADVISORY only — nothing here auto-applies. Auto-post stays OFF;
 * the recorded disposition is surfaced on /exceptions and the human-approve step is
 * still the sole apply path.
 */

import { describe, it, expect } from 'vitest';
import { scanDuplicatePayments } from './duplicate-payments';
import {
  loadAutonomyGovernance,
  decideDisposition,
  type Disposition,
} from '@/lib/autonomy/disposition';

// ── A tiny chainable fake Supabase, seeded per table (public + core schemas) ─────

type Row = Record<string, unknown>;

interface Seed {
  bills?: Row[];
  bill_payments?: Row[];
  vendors?: Row[]; // core.vendors
  organizations?: Row[]; // core.organizations
  ai_decisions?: Row[];
  autonomy_kill_switch?: Row[];
  autonomy_settings?: Row[];
}

interface FakeClient {
  from: (table: string) => FakeQuery;
  schema: (schema: string) => { from: (table: string) => FakeQuery };
  /** Everything the code under test inserted, keyed by table. */
  inserted: Record<string, Row[]>;
}

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  constructor(
    private rows: Row[],
    private sink: Row[],
  ) {}
  select(): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] !== val);
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  private result(): Row[] {
    return this.rows.filter((r) => this.filters.every((f) => f(r)));
  }
  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return Promise.resolve({ data: this.result()[0] ?? null, error: null });
  }
  single(): Promise<{ data: Row | null; error: null }> {
    return Promise.resolve({ data: this.result()[0] ?? null, error: null });
  }
  insert(payload: Row | Row[]): Promise<{ error: null }> {
    const arr = Array.isArray(payload) ? payload : [payload];
    for (const p of arr) this.sink.push(p);
    return Promise.resolve({ error: null });
  }
  // Awaitable as a plain list query.
  then<T>(
    onFulfilled: (v: { data: Row[]; error: null }) => T,
  ): Promise<T> {
    return Promise.resolve({ data: this.result(), error: null }).then(onFulfilled);
  }
}

function makeClient(seed: Seed): FakeClient {
  const store: Record<string, Row[]> = {
    'public.bills': seed.bills ?? [],
    'public.bill_payments': seed.bill_payments ?? [],
    'core.vendors': seed.vendors ?? [],
    'core.organizations': seed.organizations ?? [],
    'public.ai_decisions': seed.ai_decisions ?? [],
    'public.autonomy_kill_switch': seed.autonomy_kill_switch ?? [],
    'public.autonomy_settings': seed.autonomy_settings ?? [],
  };
  const inserted: Record<string, Row[]> = {};
  const sinkFor = (table: string): Row[] => (inserted[table] ??= []);
  const build = (schema: string, table: string): FakeQuery =>
    new FakeQuery(store[`${schema}.${table}`] ?? [], sinkFor(table));
  return {
    from: (t) => build('public', t),
    schema: (s) => ({ from: (t) => build(s, t) }),
    inserted,
  };
}

// A vendor + two duplicate bills (same vendor, same amount, 2 days apart, UNPAID)
// → EC-1 scores 0.92 → tier 'review' (a control floors 'auto' up to 'review').
function duplicateBillsSeed(extra: Partial<Seed> = {}): Seed {
  return {
    organizations: [{ id: 'org1', ai_auto_approve_threshold: 0.85, ai_auto_approve_max_cents: 1_000_000 }],
    vendors: [
      {
        id: 'v1',
        name: 'Acme Supply',
        display_name: null,
        email: null,
        tin_encrypted: null,
        address_line1: null,
        zip: null,
        ytd_spend_cents: 0,
        is_active: true,
      },
    ],
    bills: [
      { id: 'a', vendor_id: 'v1', location_id: 'loc1', bill_number: null, bill_date: '2026-03-10', total_cents: 500_000, amount_paid_cents: 0, status: 'OPEN' },
      { id: 'b', vendor_id: 'v1', location_id: 'loc1', bill_number: null, bill_date: '2026-03-12', total_cents: 500_000, amount_paid_cents: 0, status: 'OPEN' },
    ],
    ...extra,
  };
}

function firstDisposition(client: FakeClient): Disposition | undefined {
  const rows = client.inserted['ai_decisions'] ?? [];
  const po = rows[0]?.proposed_output as { disposition?: Disposition } | undefined;
  return po?.disposition;
}

// ── 1. Real detector (EC-1) records the disposition the settings imply ───────────

describe('duplicate-payments detector records autonomy disposition', () => {
  it('default (no dial, no kill switch) → PROPOSE → REVIEW', async () => {
    const client = makeClient(duplicateBillsSeed());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = await scanDuplicatePayments(client as any, 'org1');
    expect(summary.queued).toBe(1);
    expect(firstDisposition(client)).toBe('REVIEW');
  });

  it('kill switch engaged → BLOCKED (suppressed from the auto lane)', async () => {
    const client = makeClient(
      duplicateBillsSeed({ autonomy_kill_switch: [{ org_id: 'org1', engaged: true }] }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scanDuplicatePayments(client as any, 'org1');
    expect(firstDisposition(client)).toBe('BLOCKED');
  });

  it('dial up to AUTO_UNDER_LIMIT still REVIEW — a detect-only control never auto-applies', async () => {
    const client = makeClient(
      duplicateBillsSeed({
        autonomy_settings: [
          { org_id: 'org1', feature: 'DUPLICATE_PAYMENT', mode: 'AUTO_UNDER_LIMIT', materiality_limit_cents: 1_000_000 },
        ],
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scanDuplicatePayments(client as any, 'org1');
    // Amount at risk (500k) is under the 1M cap, but the control floored the score
    // tier to 'review', so the dial can never escalate it to AUTO. Canon §3.
    expect(firstDisposition(client)).toBe('REVIEW');
  });
});

// ── 2. Governance seam for a SECOND feature (ANOMALOUS_JE) — settings → disposition

describe('loadAutonomyGovernance + decideDisposition (second feature)', () => {
  it('AUTO_UNDER_LIMIT + high-confidence tier + amount under cap → AUTO', async () => {
    const client = makeClient({
      autonomy_settings: [
        { org_id: 'org1', feature: 'ANOMALOUS_JE', mode: 'AUTO_UNDER_LIMIT', materiality_limit_cents: 1_000_000 },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gov = await loadAutonomyGovernance(client as any, 'org1', 'ANOMALOUS_JE');
    expect(gov.setting?.mode).toBe('AUTO_UNDER_LIMIT');
    const { disposition } = decideDisposition({
      killSwitchEngaged: gov.killSwitchEngaged,
      setting: gov.setting,
      scoreTier: 'auto',
      amountCents: 250_000,
    });
    expect(disposition).toBe('AUTO');
  });

  it('no setting (default PROPOSE) + escalate tier → ESCALATE', async () => {
    const client = makeClient({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gov = await loadAutonomyGovernance(client as any, 'org1', 'ANOMALOUS_JE');
    expect(gov.setting).toBeNull();
    const { disposition } = decideDisposition({
      killSwitchEngaged: gov.killSwitchEngaged,
      setting: gov.setting,
      scoreTier: 'escalate',
      amountCents: 250_000,
    });
    expect(disposition).toBe('ESCALATE');
  });
});
