/**
 * Security review M4 — the vendor-compliance pay gate fails CLOSED on any error except a
 * CONFIRMED missing table (42P01 / PGRST205), and M3's read-only re-check
 * (paymentBlockReason) applies the same rule without consuming overrides.
 */
import { describe, it, expect } from 'vitest';
import { fakeSupabase, type FakeCall, type FakeResp } from '@/test/fake-supabase';
import {
  COMPLIANCE_UNAVAILABLE_MESSAGE,
  ComplianceHoldError,
  enforcePaymentAllowed,
  paymentBlockReason,
} from './vendor-compliance';
import { isMissingRelation } from '@/lib/vendor-compliance/store';

const ok = (data: unknown): FakeResp => ({ data, error: null });
const missing: FakeResp = { data: null, error: { message: 'relation "public.vendor_requirements" does not exist', code: '42P01' } };
const boom: FakeResp = { data: null, error: { message: 'permission denied for table x', code: '42501' } };

/** Default: every table empty (a compliant vendor with no docs and no sets). */
function db(overrides: Record<string, FakeResp> = {}) {
  return fakeSupabase((c: FakeCall) => {
    if (c.op !== 'select') return ok(null);
    if (overrides[c.table]) return overrides[c.table];
    if (c.table === 'bills') return ok({ location_id: null });
    if (c.table === 'vendors') return ok({ id: 'v1', is_1099_eligible: false });
    return ok([]);
  });
}

describe('isMissingRelation — only a confirmed missing table', () => {
  it('accepts 42P01 / PGRST205 / a relation message, refuses everything else', () => {
    expect(isMissingRelation({ code: '42P01', message: 'x' })).toBe(true);
    expect(isMissingRelation({ code: 'PGRST205', message: 'x' })).toBe(true);
    expect(isMissingRelation({ message: 'relation "public.t" does not exist' })).toBe(true);
    expect(isMissingRelation({ message: 'column t.foo does not exist' })).toBe(false);
    expect(isMissingRelation({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isMissingRelation({ message: 'fetch failed' })).toBe(false);
  });
});

describe('enforcePaymentAllowed — fail closed (M4)', () => {
  it('a clean vendor pays', async () => {
    await expect(enforcePaymentAllowed(db().client, 'org', 'v1', 'b1')).resolves.toBeUndefined();
  });

  it('a missing table (un-migrated DB) degrades to "no rows" and pays', async () => {
    const d = db({ vendor_bank_change_verifications: missing, vendor_requirements: missing, vendor_compliance_docs: missing, vendor_payment_holds: missing });
    await expect(enforcePaymentAllowed(d.client, 'org', 'v1', 'b1')).resolves.toBeUndefined();
  });

  for (const table of ['vendor_bank_change_verifications', 'vendor_requirements', 'vendor_compliance_docs', 'vendor_payment_holds', 'bills']) {
    it(`any other error reading ${table} HOLDS the payment`, async () => {
      await expect(enforcePaymentAllowed(db({ [table]: boom }).client, 'org', 'v1', 'b1')).rejects.toBeInstanceOf(ComplianceHoldError);
    });
  }

  it('a missing-COLUMN error is not a missing table — holds', async () => {
    const colErr: FakeResp = { data: null, error: { message: 'column vendor_compliance_docs.expiration_date does not exist', code: '42703' } };
    await expect(enforcePaymentAllowed(db({ vendor_compliance_docs: colErr }).client, 'org', 'v1', 'b1')).rejects.toBeInstanceOf(ComplianceHoldError);
  });
});

describe('paymentBlockReason — read-only re-check (M3 + M4)', () => {
  it('null for a clean vendor; never writes', async () => {
    const d = db();
    expect(await paymentBlockReason(d.client, 'org', 'v1', { billId: 'b1' })).toBeNull();
    expect(d.calls.filter((c) => c.op !== 'select')).toHaveLength(0);
  });

  it('a pending bank change blocks with the call-back message', async () => {
    const d = db({ vendor_bank_change_verifications: ok([{ id: 'bc', opened_at: '2026-10-01T00:00:00Z', source: 'manual', status: 'pending' }]) });
    expect(await paymentBlockReason(d.client, 'org', 'v1', { billId: 'b1' })).toMatch(/bank details changed on 2026-10-01/);
  });

  it('a lapsed W-9 (legacy doc rules) blocks; a one-time override already spent on THIS bill lets it through', async () => {
    const docs = ok([{ id: 'd1', doc_type: 'W9', status: 'MISSING', expiration_date: null }]);
    const held = db({ vendor_compliance_docs: docs });
    expect(await paymentBlockReason(held.client, 'org', 'v1', { billId: 'b1' })).toMatch(/compliance hold/);
    const spent = fakeSupabase((c) => {
      if (c.table === 'vendor_compliance_docs') return docs;
      if (c.table === 'vendor_payment_holds') {
        // the "spent on this bill" probe filters consumed_bill_id; the active-override read doesn't.
        return c.filters.some((f) => f[1] === 'consumed_bill_id' && f[2] === 'b1') ? ok([{ id: 'o1' }]) : ok([]);
      }
      if (c.table === 'vendors') return ok({ id: 'v1', is_1099_eligible: false });
      return ok([]);
    });
    expect(await paymentBlockReason(spent.client, 'org', 'v1', { billId: 'b1' })).toBeNull();
    expect(spent.calls.filter((c) => c.op !== 'select')).toHaveLength(0);
  });

  it('any read error → the plain-English "could not confirm" hold (fail closed)', async () => {
    expect(await paymentBlockReason(db({ vendor_compliance_docs: boom }).client, 'org', 'v1')).toBe(COMPLIANCE_UNAVAILABLE_MESSAGE);
    expect(await paymentBlockReason(db({ vendor_bank_change_verifications: boom }).client, 'org', 'v1')).toBe(COMPLIANCE_UNAVAILABLE_MESSAGE);
  });
});
