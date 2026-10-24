/**
 * core.party_score (1111) must agree with Books' customer dedupe scorer
 * (apps/web/src/lib/customers/dedupe.ts scoreCustomerDuplicates) on every pair: same confidence,
 * same matched fields. The Books module is imported as is; its app-only imports are stubbed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createReplayDb } from './pg';

vi.mock('@/lib/db/scoped-writer', () => ({ writerFor: () => null }));
vi.mock('@/lib/trust/score-tier', () => ({ getTierPolicy: async () => null, scoreToTier: () => ({ tier: 'review' }) }));
vi.mock('@/lib/trust/action-log', () => ({ logAction: async () => undefined }));
vi.mock('@meritbooks/shared', () => ({ formatMoney: (c: number) => String(c) }));
vi.mock('@/lib/services/reconciliation-match', async () => import('../../../apps/web/src/lib/services/reconciliation-match'));

type Input = { name: string; displayName?: string | null; email?: string | null; phone?: string | null; taxId?: string | null; addressLine1?: string | null; zip?: string | null };

const CASES: [Input, Input][] = [
  [{ name: 'Harbor Holdings LLC', email: 'ops@harbor.test' }, { name: 'Harbor Holdings', email: ' OPS@harbor.test ' }],
  [{ name: 'Harbor Holdings LLC', taxId: '12-3456789' }, { name: 'HH Corp', taxId: '123456789' }],
  [{ name: 'Harbor Holdings LLC', taxId: '12-3456789', phone: '515-555-0100' }, { name: 'Harbor Holdings', taxId: '12 3456789', phone: '(515) 555 0100' }],
  [{ name: 'Harbor Holdings LLC', phone: '+1 (515) 555-0100' }, { name: 'Holdings Harbor', phone: '515.555.0100' }],
  [{ name: 'Harbor Holdings LLC' }, { name: 'harbor holdings' }],
  [{ name: 'Harbor Holdings LLC' }, { name: 'Harbor Holdings Inc' }],
  [{ name: 'Harbor Holdings LLC' }, { name: 'Zephyr Plumbing', email: 'x@y.test' }],
  [{ name: 'Acme', email: 'a@acme.test' }, { name: 'Zephyr', email: 'a@acme.test' }],
  [{ name: 'Prairie Family Dental Care', email: 'desk@prairie.test' }, { name: 'Prairie Family Dental Group LLC', email: 'Desk@Prairie.test' }],
  [{ name: 'Prairie Family Dental Care', phone: '515-555-0177' }, { name: 'Prairie Family Dental Group LLC', phone: '5155550177' }],
  [{ name: 'Smith & Sons Roofing', addressLine1: '12 Oak St.', zip: '50010' }, { name: 'Smith and Sons Roofing', addressLine1: '12 oak st', zip: '50010 ' }],
  [{ name: 'Smith & Sons Roofing', addressLine1: '12 Oak St', zip: '50010' }, { name: 'Smith Sons Roofing Co', addressLine1: '12 Oak St', zip: '50011' }],
  [{ name: 'Blue Sky Builders', displayName: 'BSB' }, { name: 'B.S.B.', displayName: 'Blue Sky Builders' }],
  [{ name: 'Blue Sky Builders', phone: '555-0100' }, { name: 'Blue Sky Builders', phone: '555-0100' }],
  [{ name: 'Northwind', taxId: '123' }, { name: 'Southwind', taxId: '123' }],
  [{ name: 'Ridge Line Electric', email: 'office@ridge.test', zip: '50010', addressLine1: '1 Main' }, { name: 'Ridgeline Electric LLC', email: 'office@ridge.test' }],
  [{ name: 'Ridge Line Electric' }, { name: 'Ridge Line Electric Co', addressLine1: '1 Main', zip: '50010' }],
  [{ name: 'Ridge Line Electric', addressLine1: '1 Main', zip: '50010' }, { name: 'Ridge Line Electric Co', addressLine1: '1 Main', zip: '50010' }],
];

let db: PGlite;
let score: (a: Record<string, unknown>, b: Record<string, unknown>) => { confidence: number; matchedFields: string[] } | null;

beforeAll(async () => {
  ({ db } = await createReplayDb());
  // non-literal specifier: the Books module is resolved by vitest at run time, not by this package's tsc
  const dedupePath = '../../../apps/web/src/lib/customers/dedupe';
  const mod = (await import(/* @vite-ignore */ dedupePath)) as { scoreCustomerDuplicates: unknown };
  score = mod.scoreCustomerDuplicates as unknown as typeof score;
}, 600_000);

afterAll(async () => {
  await db?.close();
});

describe('core.party_score == dedupe.ts scoreCustomerDuplicates', () => {
  it.each(CASES.map((c, i) => [i, c] as const))('case %i', async (_i, [a, b]) => {
    const full = (x: Input, id: string) => ({ id, name: x.name, displayName: x.displayName ?? null, email: x.email ?? null, phone: x.phone ?? null,
      taxId: x.taxId ?? null, addressLine1: x.addressLine1 ?? null, zip: x.zip ?? null, openArCents: 0 });
    const ts = score(full(a, 'a'), full(b, 'b'));
    const r = (await db.query<{ score: string | null; matched: string[] }>(
      `select score, matched from core.party_score($1::text[], $2::text[], $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [[a.name, a.displayName ?? null], [b.name, b.displayName ?? null], a.email ?? null, b.email ?? null, a.phone ?? null, b.phone ?? null,
       a.addressLine1 ?? null, b.addressLine1 ?? null, a.zip ?? null, b.zip ?? null, a.taxId ?? null, b.taxId ?? null])).rows[0];
    if (ts === null) {
      expect(r.score).toBeNull();
    } else {
      expect(Number(r.score)).toBeCloseTo(ts.confidence, 6);
      expect(r.matched).toEqual(ts.matchedFields);
    }
  });

  it('the cases cover every rule of the curve', () => {
    const seen = new Set(CASES.map(([a, b]) => {
      const full = (x: Input, id: string) => ({ id, name: x.name, displayName: x.displayName ?? null, email: x.email ?? null, phone: x.phone ?? null,
        taxId: x.taxId ?? null, addressLine1: x.addressLine1 ?? null, zip: x.zip ?? null, openArCents: 0 });
      const s = score(full(a, 'a'), full(b, 'b'));
      return s ? `${s.confidence}:${s.matchedFields[0]}` : 'none';
    }));
    for (const k of ['0.96:tax_id', '0.93:name', '0.9:email', '0.86:phone', '0.82:name', 'none']) expect(seen).toContain(k);
  });
});
