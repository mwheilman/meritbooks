import { describe, it, expect } from 'vitest';
import { memorySupabase, type MemTables } from '@/test/memory-supabase';
import type { ClientScopeState } from '@/lib/rbac/client-scope';
import {
  capPerLane,
  countNeedsAttention,
  countsForLocation,
  decideWorkScope,
  loadNeedsAttention,
  normalizeRequestedClient,
  scopeWorkItems,
  summarizeWork,
  toExceptionItems,
  WORK_LANES,
  ORG_LEVEL_KEY,
  type WorkScope,
} from './needs-attention';
import { toExceptionsResponse, type InboxResponse } from '@/app/(app)/inbox/inbox-types';

// Slice 1F — the Inbox must never show another client's items, the server must refuse
// an out-of-scope client, and the home / Inbox tabs / rail badge must agree because
// they all come from this one service.

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ASOF = '2026-10-23';

const state = (mode: ClientScopeState['mode'], ids: string[] = [], allClients = false): ClientScopeState => ({
  mode,
  membershipId: 'm1',
  allClients,
  locationIds: new Set(ids),
});

/** Two clients' worth of every lane, plus organization-level items. */
function seed(): MemTables {
  return {
    approvals: [
      // Client resolves through the subject bill.
      { id: 'ap-a', kind: 'AP_DISBURSEMENT', subject_table: 'bills', subject_id: 'bill-a', amount_cents: 1000, created_at: '2026-10-20', status: 'PENDING_APPROVAL' },
      { id: 'ap-b', kind: 'AP_DISBURSEMENT', subject_table: 'bills', subject_id: 'bill-b', amount_cents: 2000, created_at: '2026-10-20', status: 'PENDING_APPROVAL' },
      // No locatable subject → organization-level.
      { id: 'ap-org', kind: 'PAYROLL_RUN', subject_table: 'organizations', subject_id: 'o1', amount_cents: 3000, created_at: '2026-10-21', status: 'PENDING_APPROVAL' },
      { id: 'ap-done', kind: 'AP_BATCH', subject_table: 'bills', subject_id: 'bill-a', amount_cents: 1, created_at: '2026-10-01', status: 'APPROVED' },
    ],
    bills: [
      { id: 'bill-a', location_id: A, status: 'PENDING', bill_number: 'A-1', total_cents: 1000, vendor_id: null, created_at: '2026-10-19' },
      { id: 'bill-b', location_id: B, status: 'PENDING', bill_number: 'B-1', total_cents: 2000, vendor_id: null, created_at: '2026-10-19' },
      { id: 'hold-a', location_id: A, status: 'ON_HOLD', bill_number: 'A-2', total_cents: 500, payment_hold_reason: 'Missing W-9', vendor_id: null, created_at: '2026-10-18' },
    ],
    ai_decisions: [
      { id: 'ai-a1', location_id: A, status: 'PROPOSED', feature: 'CATEGORIZATION', input_summary: 'A txn', confidence: 0.6, proposed_output: { disposition: 'REVIEW' }, created_at: '2026-10-22' },
      { id: 'ai-a2', location_id: A, status: 'PROPOSED', feature: 'CATEGORIZATION', input_summary: 'A txn 2', confidence: 0.4, proposed_output: null, created_at: '2026-10-22' },
      // The leak in the live check: a covenant item on ANOTHER client.
      { id: 'ai-b1', location_id: B, status: 'PROPOSED', feature: 'COVENANT_DRIFT', input_summary: 'B covenant', confidence: 0.9, proposed_output: { disposition: 'ESCALATE' }, created_at: '2026-10-22' },
      // Organization-level (a loan file with no client).
      { id: 'ai-org', location_id: null, status: 'PROPOSED', feature: 'DEBT_EXTRACT', input_summary: 'Loan file', confidence: null, proposed_output: null, created_at: '2026-10-22' },
      { id: 'ai-gone', location_id: A, status: 'REJECTED', feature: 'X', input_summary: 'old', confidence: 0.1, proposed_output: null, created_at: '2026-10-01' },
    ],
    bank_transactions: [
      { id: 'bt-a', location_id: A, status: 'FLAGGED', description: 'A flagged', amount_cents: -4200, ai_reasoning: 'Odd', created_at: '2026-10-21' },
      { id: 'bt-b', location_id: B, status: 'FLAGGED', description: 'B flagged', amount_cents: -100, ai_reasoning: null, created_at: '2026-10-21' },
      { id: 'bt-a-ok', location_id: A, status: 'PENDING', description: 'A pending', amount_cents: -1, created_at: '2026-10-21' },
    ],
    receipts: [{ id: 'rc-b', location_id: B, status: 'FLAGGED', vendor_name: 'B receipt', amount_cents: 900, submitted_at: '2026-10-20' }],
    job_cost_attributions: [{ id: 'jc-a', location_id: A, lifecycle: 'PENDING', cost_type: 'LABOR', memo: null, amount_cents: 300, created_at: '2026-10-20' }],
    expense_reports: [
      { id: 'er-b', location_id: B, status: 'SUBMITTED', title: 'B trip', total_cents: 5000, policy_flag_count: 0, submitted_at: '2026-10-20', created_at: '2026-10-19' },
      { id: 'er-a', location_id: A, status: 'DRAFT', title: 'A draft', total_cents: 100, policy_flag_count: 2, submitted_at: null, created_at: '2026-10-19' },
    ],
    gl_entries: [
      { id: 'je-a', location_id: A, status: 'PENDING', entry_number: 'JE-1', memo: 'Accrual', source_module: 'MANUAL', created_at: '2026-10-20' },
      { id: 'je-b', location_id: B, status: 'PENDING', entry_number: 'JE-2', memo: null, source_module: null, created_at: '2026-10-20' },
      { id: 'je-sys', location_id: A, status: 'PENDING', entry_number: 'JE-3', memo: null, source_module: 'PAYROLL', created_at: '2026-10-20' },
    ],
    leases: [
      { id: 'ls-a', location_id: A, status: 'ACTIVE', lessor: 'Lessor A', description: null, end_date: '2026-10-25', payment_cents: 100 },
      { id: 'ls-b', location_id: B, status: 'ACTIVE', lessor: 'Lessor B', description: null, end_date: '2026-10-26', payment_cents: 100 },
    ],
    'core.locations': [
      { id: A, name: '[SANDBOX] Coho Flooring' },
      { id: B, name: 'Acme Test Co' },
    ],
  };
}

const scopeOf = (locationId: string | null, s: ClientScopeState = state('off')): WorkScope => ({ locationId, state: s });

describe('resolveWorkScope decision (server-side client scope)', () => {
  it('treats absent / empty / "all" as the all-clients context', () => {
    expect(normalizeRequestedClient(undefined)).toBeNull();
    expect(normalizeRequestedClient('')).toBeNull();
    expect(normalizeRequestedClient('all')).toBeNull();
    expect(decideWorkScope(state('enforce', [A]), null)).toEqual({ ok: true, scope: { locationId: null, state: state('enforce', [A]) } });
  });

  it('rejects a malformed client id (400)', () => {
    const r = decideWorkScope(state('off'), 'not-a-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('REFUSES an out-of-scope client under enforce (403) — not just hidden in the UI', () => {
    const r = decideWorkScope(state('enforce', [A]), B);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.code).toBe('CLIENT_OUT_OF_SCOPE');
    }
  });

  it('allows an in-scope client under enforce, and any client under shadow/off (shadow logs would_deny)', () => {
    expect(decideWorkScope(state('enforce', [A]), A).ok).toBe(true);
    expect(decideWorkScope(state('enforce', [], true), B).ok).toBe(true); // all_clients assignment
    expect(decideWorkScope(state('shadow', [A]), B).ok).toBe(true);
    expect(decideWorkScope(state('off'), B).ok).toBe(true);
  });
});

describe('scopeWorkItems (pure)', () => {
  const items = [
    { id: 1, locationId: A },
    { id: 2, locationId: B },
    { id: 3, locationId: null },
  ];
  it('a selected client returns ONLY that client (no other client, no org-level)', () => {
    expect(scopeWorkItems(items, scopeOf(A)).items.map((i) => i.id)).toEqual([1]);
  });
  it('all clients under enforce drops out-of-scope clients and keeps org-level', () => {
    const r = scopeWorkItems(items, scopeOf(null, state('enforce', [A])));
    expect(r.items.map((i) => i.id)).toEqual([1, 3]);
    expect(r.outOfScopeLocationIds).toEqual([B]);
  });
  it('all clients under shadow keeps everything but reports the out-of-scope client', () => {
    const r = scopeWorkItems(items, scopeOf(null, state('shadow', [A])));
    expect(r.items).toHaveLength(3);
    expect(r.outOfScopeLocationIds).toEqual([B]);
  });
});

describe('loadNeedsAttention — every Inbox lane is scoped to the active client', () => {
  it('client A selected never returns a client-B (or org-level) item in ANY lane', async () => {
    const db = memorySupabase(seed());
    const r = await loadNeedsAttention(db.client, { scope: scopeOf(A), asOf: ASOF, alertHorizonDays: 30 });
    expect(r.items.length).toBeGreaterThan(0);
    for (const it of r.items) expect(it.locationId).toBe(A);
    const lanes = new Set(r.items.map((i) => i.lane));
    expect(lanes).toEqual(new Set(WORK_LANES)); // approvals, exceptions, alerts, drafts all present for A
    // The approval resolved to A through its subject bill; B's didn't leak in.
    expect(r.items.some((i) => i.entity.id === 'ap-a')).toBe(true);
    expect(r.items.some((i) => i.entity.id === 'ap-b' || i.entity.id === 'ap-org')).toBe(false);
    // The other client's covenant proposal is not here.
    expect(r.items.some((i) => i.entity.id === 'ai-b1')).toBe(false);
    // System-posted drafts are not surfaced; the manual one is.
    expect(r.items.filter((i) => i.lane === 'drafts').map((i) => i.entity.id)).toEqual(['je-a']);
    expect(r.scope).toEqual({ locationId: A, isAll: false });
  });

  it('all clients returns both clients plus an Organization bucket, each item named', async () => {
    const db = memorySupabase(seed());
    const r = await loadNeedsAttention(db.client, { scope: scopeOf(null), asOf: ASOF });
    expect(new Set(r.items.map((i) => i.locationId))).toEqual(new Set([A, B, null]));
    expect(r.items.find((i) => i.entity.id === 'ai-b1')?.locationName).toBe('Acme Test Co');
    expect(r.items.find((i) => i.entity.id === 'ai-org')?.locationName).toBeNull();
    expect(r.counts.byLocation[ORG_LEVEL_KEY].total).toBe(2); // ap-org + ai-org
  });

  it('counts are exact (no 100-row cap) and the four lanes sum to the total', async () => {
    const many: MemTables = {
      ai_decisions: Array.from({ length: 109 }, (_, i) => ({
        id: `ai-${i}`,
        location_id: A,
        status: 'PROPOSED',
        feature: 'CATEGORIZATION',
        input_summary: `t${i}`,
        confidence: 0.5,
        proposed_output: null,
        created_at: '2026-10-22',
      })),
    };
    const r = await loadNeedsAttention(memorySupabase(many).client, { scope: scopeOf(A), asOf: ASOF });
    expect(r.counts.byLane.exceptions).toBe(109);
    expect(r.counts.total).toBe(WORK_LANES.reduce((n, l) => n + r.counts.byLane[l], 0));
  });
});

describe('ONE counting service: home, Inbox tabs and rail badge agree', () => {
  it('countNeedsAttention (home + rail) equals loadNeedsAttention (Inbox) for the same scope', async () => {
    for (const loc of [A, B, null]) {
      const list = await loadNeedsAttention(memorySupabase(seed()).client, { scope: scopeOf(loc), asOf: ASOF });
      const counts = await countNeedsAttention(memorySupabase(seed()).client, { scope: scopeOf(loc), asOf: ASOF });
      expect(counts.counts.total).toBe(list.counts.total);
      expect(counts.counts.byLane).toEqual(list.counts.byLane);
      // The counts are derived from the list itself.
      expect(list.counts.total).toBe(list.items.length);
    }
  });

  it('the all-clients per-client breakdown equals each client’s own scoped counts (workspace row = client home)', async () => {
    const all = await countNeedsAttention(memorySupabase(seed()).client, { scope: scopeOf(null), asOf: ASOF });
    for (const loc of [A, B]) {
      const one = await countNeedsAttention(memorySupabase(seed()).client, { scope: scopeOf(loc), asOf: ASOF });
      expect(countsForLocation(all.counts, loc).lanes).toEqual(one.counts.byLane);
      expect(countsForLocation(all.counts, loc).total).toBe(one.counts.total);
    }
  });

  it('the Inbox tab badges and the Exceptions list come from the same payload, and AI-disposition chips sum to the AI rows', async () => {
    const r = await loadNeedsAttention(memorySupabase(seed()).client, { scope: scopeOf(A), asOf: ASOF });
    const payload: InboxResponse = {
      asOf: r.asOf,
      canApproveMoney: false,
      scope: r.scope,
      items: r.items,
      groups: [],
      counts: r.counts,
      truncated: { approvals: false, exceptions: false, alerts: false, drafts: false },
      degraded: r.degraded,
    };
    const ex = toExceptionsResponse(payload);
    expect(ex.data).toHaveLength(r.counts.byLane.exceptions);
    expect(ex.counts.total).toBe(r.counts.byLane.exceptions);
    const aiRows = ex.data.filter((d) => d.source === 'ai_proposal').length;
    const dispoSum = Object.values(ex.counts.byDisposition).reduce((n, v) => n + v, 0) + ex.counts.unscored;
    expect(dispoSum).toBe(aiRows);
    // The server-side projection matches the client-side one row for row.
    expect(toExceptionItems(r.items).map((e) => `${e.source}:${e.id}`)).toEqual(ex.data.map((e) => `${e.source}:${e.id}`));
  });

  it('capPerLane bounds the list but never the counts', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ lane: i < 5 ? ('exceptions' as const) : ('drafts' as const), i }));
    const { items: capped, truncated } = capPerLane(items, 3);
    expect(capped.filter((x) => x.lane === 'exceptions')).toHaveLength(3);
    expect(capped.filter((x) => x.lane === 'drafts')).toHaveLength(2);
    expect(truncated).toEqual({ approvals: false, exceptions: true, alerts: false, drafts: false });
  });

  it('summarizeWork of nothing is all zeros (the shape shown before any load)', () => {
    const c = summarizeWork([]);
    expect(c.total).toBe(0);
    expect(c.byLane).toEqual({ approvals: 0, exceptions: 0, alerts: 0, drafts: 0 });
  });
});
