/**
 * Matching at the door (SHARED-RECORDS §3): the pure classification the forms and the server
 * share, the decision rules (exact → existing by default, new needs a typed reason; likely →
 * pick), and the server door against a fake matcher.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  NEW_REASON_MIN, MatchDecisionBody, MatchQuery, alreadyInMerit, candidateLine, checkDecision, decisionBody, defaultDecision, isExact, isLikely,
  matchArgs, matchVerdict, matchWorthAsking, monthWords, parseCandidates, reconcileDecision, type MatchCandidate,
} from '@/lib/parties/match';
import { matchConflict, matchOrCreateCustomer, resolveAtDoor } from '@/lib/parties/server';
import type { SupabaseClient } from '@supabase/supabase-js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const cand = (id: string, matched: string[], score = 0.9, detail: Record<string, unknown> = {}): MatchCandidate =>
  parseCandidates([{ id, name: id === A ? 'Harbor Holdings' : 'Harbour Holdings LLC', score, matched, detail }])[0]!;

describe('parseCandidates', () => {
  it('keeps good rows best first, drops bad ones, reads detail', () => {
    const r = parseCandidates([
      { id: B, name: 'B', score: 0.6, matched: ['name'] },
      { id: A, name: 'A', score: '0.95', matched: ['email', 7], detail: { books_since: '2026-03-04', email: 'ap@harbor.com' } },
      { name: 'no id' },
      null,
      'x',
    ]);
    expect(r.map((c) => c.id)).toEqual([A, B]);
    expect(r[0]!.matched).toEqual(['email']);
    expect(r[0]!.detail.booksSince).toBe('2026-03-04');
    expect(r[0]!.detail.email).toBe('ap@harbor.com');
  });
  it('accepts a 0–100 score and clamps', () => {
    expect(parseCandidates([{ id: A, name: 'A', score: 87, matched: [] }])[0]!.score).toBeCloseTo(0.87);
    expect(parseCandidates([{ id: A, name: 'A', score: 'x', matched: [] }])[0]!.score).toBe(0);
  });
  it('is empty for anything that is not an array', () => {
    expect(parseCandidates(null)).toEqual([]);
    expect(parseCandidates({ id: A })).toEqual([]);
  });
});

describe('the 1111 matcher shape', () => {
  it('detail.level from core.match_parties wins over the matched list', () => {
    const [c] = parseCandidates([{ id: A, name: 'Harbor', score: 0.82, matched: ['name'], detail: { level: 'exact' } }]);
    expect(isExact(c!)).toBe(true);
    const [d] = parseCandidates([{ id: A, name: 'Harbor', score: 0.93, matched: ['name', 'email'], detail: { level: 'likely' } }]);
    expect(isExact(d!)).toBe(false);
    expect(isLikely(d!)).toBe(true);
  });
  it('a contact known only by email is named by it', () => {
    const [c] = parseCandidates([{ id: A, name: null, score: 0.9, matched: ['email'], detail: { level: 'exact', email: 'dana@x.com' } }]);
    expect(c!.name).toBe('dana@x.com');
    expect(parseCandidates([{ id: A, name: null, score: 0.9, matched: [] }])).toEqual([]);
  });
});

describe('exact vs likely', () => {
  it('one hard identifier is exact', () => {
    for (const k of ['email', 'phone', 'tax_id', 'name_address']) expect(isExact({ matched: [k] }), k).toBe(true);
    expect(isExact({ matched: ['name', 'address'] })).toBe(true);
  });
  it('a similar name alone is not exact', () => {
    expect(isExact({ matched: ['name'] })).toBe(false);
    expect(isExact({ matched: ['name', 'city'] })).toBe(false);
  });
  it('likely = similar name plus one shared identifier, or a strong score', () => {
    expect(isLikely({ matched: ['name', 'city'], score: 0.3 })).toBe(true);
    expect(isLikely({ matched: ['name'], score: 0.6 })).toBe(true);
    expect(isLikely({ matched: ['name'], score: 0.3 })).toBe(false);
    expect(isLikely({ matched: [], score: 0.85 })).toBe(true);
  });
});

describe('matchVerdict and the default decision', () => {
  it('exact → existing record chosen by default', () => {
    const v = matchVerdict([cand(B, ['name', 'city'], 0.7), cand(A, ['email'], 0.95)]);
    expect(v.kind).toBe('exact');
    if (v.kind !== 'exact') return;
    expect(v.best.id).toBe(A);
    expect(v.others.map((c) => c.id)).toEqual([B]);
    expect(defaultDecision(v)).toEqual({ use: A });
  });
  it('likely → nothing chosen; the person must pick', () => {
    const v = matchVerdict([cand(B, ['name', 'zip'], 0.6)]);
    expect(v.kind).toBe('likely');
    expect(defaultDecision(v)).toBeNull();
    expect(checkDecision(v, null).ok).toBe(false);
    expect(checkDecision(v, { create: true, reason: '' }).ok).toBe(true);
    expect(checkDecision(v, { use: B }).ok).toBe(true);
  });
  it('none → create', () => {
    const v = matchVerdict([cand(B, ['name'], 0.2)]);
    expect(v.kind).toBe('none');
    expect(defaultDecision(v)).toEqual({ create: true, reason: null });
    expect(checkDecision(v, defaultDecision(v)).ok).toBe(true);
  });
  it('creating beside an exact match needs a typed reason', () => {
    const v = matchVerdict([cand(A, ['phone'])]);
    const short = checkDecision(v, { create: true, reason: 'dup' }, 'customer');
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.message).toContain('Harbor Holdings');
    expect(checkDecision(v, { create: true, reason: 'x'.repeat(NEW_REASON_MIN) }).ok).toBe(true);
    expect(checkDecision(v, { use: A }).ok).toBe(true);
  });
});

describe('reconcileDecision (new candidates while typing)', () => {
  const exact = matchVerdict([cand(A, ['email'])]);
  const likely = matchVerdict([cand(B, ['name', 'city'], 0.6)]);
  const none = matchVerdict([]);
  it('the automatic "create" default flips to the existing record when an exact match appears', () => {
    expect(reconcileDecision({ create: true, reason: null }, exact)).toEqual({ use: A });
  });
  it('a person who chose "add new" keeps that choice', () => {
    expect(reconcileDecision({ create: true, reason: 'Different branch' }, exact)).toEqual({ create: true, reason: 'Different branch' });
    expect(reconcileDecision({ create: true, reason: '' }, likely)).toEqual({ create: true, reason: '' });
  });
  it('a chosen record that disappears falls back to the default', () => {
    expect(reconcileDecision({ use: A }, likely)).toBeNull();
    expect(reconcileDecision({ use: A }, none)).toEqual({ create: true, reason: null });
    expect(reconcileDecision({ use: A }, exact)).toEqual({ use: A });
  });
});

describe('words', () => {
  it('"Already in Merit: <name> — used in Books since <month>"', () => {
    expect(alreadyInMerit(cand(A, ['email'], 0.9, { books_since: '2026-03-12' }), 2026)).toBe('Already in Merit: Harbor Holdings — used in Books since March');
    expect(alreadyInMerit(cand(A, ['email'], 0.9, { books_since: '2024-11-01' }), 2026)).toBe('Already in Merit: Harbor Holdings — used in Books since November 2024');
    expect(alreadyInMerit(cand(A, ['email'], 0.9, { created_at: '2026-10-01T00:00:00Z' }), 2026)).toBe('Already in Merit: Harbor Holdings — added October');
    expect(alreadyInMerit(cand(A, ['email']), 2026)).toBe('Already in Merit: Harbor Holdings — already on your list');
  });
  it('candidate line says what matched', () => {
    expect(candidateLine(cand(A, ['email', 'name'], 0.9, { city: 'Ames', email: 'ap@harbor.com' }))).toBe('same email, similar name · ap@harbor.com · Ames');
    expect(monthWords('bad')).toBe('bad');
  });
});

describe('request shapes', () => {
  it('maps the query to the §9 core.match_parties signature', () => {
    const q = MatchQuery.parse({ op: 'customer', name: ' Harbor ', email: 'AP@Harbor.com', phone: '', taxId: null });
    expect(matchArgs(q)).toEqual({ p_kind: 'customer', p_name: 'Harbor', p_email: 'ap@harbor.com', p_phone: null, p_address: null, p_tax_id: null, p_limit: 5 });
    expect(MatchQuery.safeParse({ op: 'site' }).success).toBe(false);
  });
  it('asks only when there is something to match', () => {
    expect(matchWorthAsking({ name: 'Ha', email: null, phone: null, taxId: null })).toBe(false);
    expect(matchWorthAsking({ name: 'Har', email: null, phone: null, taxId: null })).toBe(true);
    expect(matchWorthAsking({ name: null, email: null, phone: '515-55', taxId: null })).toBe(false);
    expect(matchWorthAsking({ name: null, email: null, phone: '515-555-0100', taxId: null })).toBe(true);
  });
  it('decision body round-trips', () => {
    expect(decisionBody({ use: A })).toEqual({ useId: A, newReason: null });
    expect(decisionBody({ create: true, reason: '  other office ' })).toEqual({ useId: null, newReason: 'other office' });
    expect(decisionBody(null)).toEqual({ useId: null, newReason: null });
    expect(MatchDecisionBody.parse(undefined)).toEqual({ useId: null, newReason: null });
    expect(MatchDecisionBody.safeParse({ useId: 'nope' }).success).toBe(false);
  });
});

// ------------------------------------------------------------------ the server door

function fakeDb(opts: { candidates?: unknown[]; rpcError?: { code: string; message: string }; reachable?: boolean }) {
  const rpc = vi.fn(async () => (opts.rpcError ? { data: null, error: opts.rpcError } : { data: opts.candidates ?? [], error: null }));
  const maybeSingle = vi.fn(async () => ({ data: opts.reachable === false ? null : { id: A }, error: null }));
  const chain = { select: () => chain, eq: () => chain, maybeSingle };
  const db = { schema: () => ({ rpc, from: () => chain }) } as unknown as SupabaseClient;
  return { db, rpc };
}

describe('resolveAtDoor', () => {
  const who = { name: 'Harbor Holdings', email: 'ap@harbor.com', phone: null };
  it('an exact match with no reason is a conflict carrying the candidates', async () => {
    const { db, rpc } = fakeDb({ candidates: [{ id: A, name: 'Harbor Holdings', score: 0.97, matched: ['email'] }] });
    const r = await resolveAtDoor(db, 'customer', who, { useId: null, newReason: null });
    expect(r.kind).toBe('conflict');
    expect(rpc).toHaveBeenCalledWith('match_parties', expect.objectContaining({ p_kind: 'customer', p_email: 'ap@harbor.com' }));
  });
  it('a typed reason lets the second record through, noting which one it shadows', async () => {
    const { db } = fakeDb({ candidates: [{ id: A, name: 'Harbor Holdings', score: 0.97, matched: ['email'] }] });
    const r = await resolveAtDoor(db, 'customer', who, { useId: null, newReason: 'Separate Des Moines branch' });
    expect(r).toEqual(expect.objectContaining({ kind: 'create', reason: 'Separate Des Moines branch' }));
    if (r.kind === 'create') expect(r.overrideOf?.id).toBe(A);
  });
  it('choosing the existing record uses it without asking the matcher', async () => {
    const { db, rpc } = fakeDb({});
    expect(await resolveAtDoor(db, 'customer', who, { useId: A, newReason: null })).toEqual({ kind: 'use', id: A });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('a chosen record the caller cannot reach is a 404', async () => {
    const { db } = fakeDb({ reachable: false });
    await expect(resolveAtDoor(db, 'customer', who, { useId: A, newReason: null })).rejects.toMatchObject({ status: 404 });
  });
  it('likely and no matches create', async () => {
    const { db } = fakeDb({ candidates: [{ id: B, name: 'Harbour', score: 0.6, matched: ['name', 'city'] }] });
    expect((await resolveAtDoor(db, 'customer', who, { useId: null, newReason: null })).kind).toBe('create');
  });
  it('before migration 1111 the door creates (the matcher is missing, not failing)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = fakeDb({ rpcError: { code: 'PGRST202', message: 'Could not find the function core.match_parties' } });
    expect((await resolveAtDoor(db, 'customer', who, { useId: null, newReason: null })).kind).toBe('create');
    warn.mockRestore();
  });
  it('other matcher errors fail the save', async () => {
    const { db } = fakeDb({ rpcError: { code: '42501', message: 'PM_FORBIDDEN: no' } });
    await expect(resolveAtDoor(db, 'customer', who, { useId: null, newReason: null })).rejects.toBeTruthy();
  });
  it('a door with nobody choosing uses the exact match', async () => {
    const { db } = fakeDb({ candidates: [{ id: A, name: 'Harbor Holdings', score: 0.97, matched: ['name_address'] }] });
    const create = vi.fn(async () => B);
    expect(await matchOrCreateCustomer(db, who, create)).toEqual({ id: A, existing: true });
    expect(create).not.toHaveBeenCalled();
    const { db: db2 } = fakeDb({ candidates: [] });
    expect(await matchOrCreateCustomer(db2, who, create)).toEqual({ id: B, existing: false });
  });
  it('the 409 body carries code, field and candidates', async () => {
    const res = matchConflict('customer', [cand(A, ['email'])], 'customer');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; field: string; candidates: MatchCandidate[] };
    expect(body.code).toBe('MATCH_FOUND');
    expect(body.field).toBe('customer');
    expect(body.candidates[0]!.id).toBe(A);
  });
});
