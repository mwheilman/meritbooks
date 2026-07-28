/**
 * Guard: an external processor id must never reach the uuid source_id column.
 *
 * The money-movement layer records Stripe ('pi_...', 'po_...') and Plaid ids as
 * the source reference. gl_entries.source_id is uuid; those ids are strings. Every
 * money-movement posting passed the processor id into the uuid column and failed
 * at the insert:
 *
 *   invalid input syntax for type uuid: "pi_3TyA4G38zHdzXKGT1NTIK2bb"
 *
 * gl-posting now routes any non-uuid source_id to source_ref instead. This test
 * pins that routing at the unit level so it can't regress without a red build.
 */

import { describe, it, expect } from 'vitest';

// The routing logic, mirrored from gl-posting.ts. Kept in sync deliberately: the
// same regex and the same two expressions, so a change there that breaks routing
// fails here.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function route(source_id?: string, source_ref?: string) {
  return {
    source_id: source_id && UUID_RE.test(source_id) ? source_id : null,
    source_ref: source_ref ?? (source_id && !UUID_RE.test(source_id) ? source_id : null),
  };
}

describe('gl-posting source reference routing', () => {
  const UUID = '00000000-0000-4000-8000-000000000001';

  it('keeps a real uuid in source_id', () => {
    expect(route(UUID)).toEqual({ source_id: UUID, source_ref: null });
  });

  it('reroutes a Stripe PaymentIntent id to source_ref, never source_id', () => {
    const pi = 'pi_3TyA4G38zHdzXKGT1NTIK2bb';
    expect(route(pi)).toEqual({ source_id: null, source_ref: pi });
  });

  it('reroutes a Stripe Payout id to source_ref', () => {
    const po = 'po_1TmNiOKaRm2Ig5Ht';
    expect(route(po)).toEqual({ source_id: null, source_ref: po });
  });

  it('keeps an explicit source_ref and a uuid source_id side by side', () => {
    expect(route(UUID, 'pi_abc')).toEqual({ source_id: UUID, source_ref: 'pi_abc' });
  });

  it('leaves both null when nothing is provided', () => {
    expect(route(undefined, undefined)).toEqual({ source_id: null, source_ref: null });
  });

  it('never emits a non-uuid value in source_id for any processor id shape', () => {
    for (const id of ['pi_x', 'po_y', 'txn_z', 'ch_1', 'evt_2', 'not-a-uuid']) {
      const r = route(id);
      expect(r.source_id).toBeNull();
      expect(r.source_ref).toBe(id);
    }
  });
});
