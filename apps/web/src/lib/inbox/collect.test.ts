import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ageInDays,
  formatAge,
  formatDue,
  severityForApproval,
  severityForAlertDays,
  buildApprovalItem,
  buildExpenseReportItem,
  buildBillHoldItem,
  buildAiProposalItem,
  buildObligationItem,
  buildJeDraftItem,
  rankInboxItems,
  groupInboxItems,
  countsByType,
  collectInbox,
  GROUP_FOR_TYPE,
  type InboxItem,
} from './collect';
import { makeObligation } from '@/lib/obligations/collect';

const ASOF = '2026-08-02';

// ---------------------------------------------------------------------------
// Pure date / age math
// ---------------------------------------------------------------------------

describe('age + due math', () => {
  it('ageInDays counts whole days elapsed since the timestamp', () => {
    expect(ageInDays(ASOF, '2026-08-02')).toBe(0);
    expect(ageInDays(ASOF, '2026-07-30')).toBe(3);
    expect(ageInDays(ASOF, '2026-07-03')).toBe(30);
    expect(ageInDays(ASOF, '2026-08-01T09:00:00Z')).toBe(1);
  });

  it('ageInDays returns null on unparseable input', () => {
    expect(ageInDays(ASOF, null)).toBeNull();
    expect(ageInDays(ASOF, 'garbage')).toBeNull();
  });

  it('formatAge speaks human', () => {
    expect(formatAge(0)).toBe('today');
    expect(formatAge(1)).toBe('1d ago');
    expect(formatAge(5)).toBe('5d ago');
    expect(formatAge(60)).toBe('2mo ago');
    expect(formatAge(400)).toBe('1y ago');
  });

  it('formatDue speaks human (overdue negative)', () => {
    expect(formatDue(-3)).toBe('3d overdue');
    expect(formatDue(0)).toBe('due today');
    expect(formatDue(5)).toBe('in 5d');
  });
});

// ---------------------------------------------------------------------------
// Severity derivation
// ---------------------------------------------------------------------------

describe('severity', () => {
  it('an approval you can clear is CRITICAL; otherwise HIGH', () => {
    expect(severityForApproval(true)).toBe('CRITICAL');
    expect(severityForApproval(false)).toBe('HIGH');
  });

  it('alert severity: overdue CRITICAL, this-week HIGH, else MEDIUM', () => {
    expect(severityForAlertDays(-1)).toBe('CRITICAL');
    expect(severityForAlertDays(0)).toBe('HIGH');
    expect(severityForAlertDays(7)).toBe('HIGH');
    expect(severityForAlertDays(8)).toBe('MEDIUM');
  });
});

// ---------------------------------------------------------------------------
// Common-shape builders (shaping)
// ---------------------------------------------------------------------------

describe('builders (source → common shape)', () => {
  it('shapes a money-movement approval and deep-links by kind', () => {
    const item = buildApprovalItem(
      ASOF,
      { id: 'a1', kind: 'AP_DISBURSEMENT', subject_table: 'bill_payments', amount_cents: -500000, created_at: '2026-07-30' },
      true,
    );
    expect(item.type).toBe('APPROVAL');
    expect(item.group).toBe('APPROVALS');
    expect(item.title).toBe('AP disbursement');
    expect(item.actionHref).toBe('/checks');
    expect(item.actionLabel).toBe('Approve');
    expect(item.severity).toBe('CRITICAL');
    expect(item.amountCents).toBe(500000); // abs value
    expect(item.dueOrAge).toBe('3d ago');
    expect(item.id).toBe('APPROVAL:a1');
  });

  it('a caller who cannot approve gets a HIGH "View" approval, not CRITICAL "Approve"', () => {
    const item = buildApprovalItem(
      ASOF,
      { id: 'a2', kind: 'PAYROLL_RUN', subject_table: 'payroll_runs', amount_cents: 1000, created_at: ASOF },
      false,
    );
    expect(item.severity).toBe('HIGH');
    expect(item.actionLabel).toBe('View');
    expect(item.actionHref).toBe('/payroll');
  });

  it('a SUBMITTED expense report is an approval; a flagged DRAFT is a policy block', () => {
    const submitted = buildExpenseReportItem(
      ASOF,
      { id: 'e1', title: 'Sales trip', total_cents: 25000, policy_flag_count: 1, status: 'SUBMITTED', submitted_at: '2026-08-01', created_at: '2026-07-28' },
      true,
    );
    expect(submitted?.type).toBe('APPROVAL');
    expect(submitted?.actionHref).toBe('/expenses');
    expect(submitted?.subtitle).toContain('1 policy flag');

    const draft = buildExpenseReportItem(
      ASOF,
      { id: 'e2', title: 'Ops', total_cents: 9000, policy_flag_count: 2, status: 'DRAFT', submitted_at: null, created_at: '2026-08-01' },
      true,
    );
    expect(draft?.type).toBe('POLICY_BLOCK');
    expect(draft?.severity).toBe('HIGH');
    expect(draft?.subtitle).toContain('2 expense-policy flags');
  });

  it('a clean DRAFT expense report is not surfaced', () => {
    const draft = buildExpenseReportItem(
      ASOF,
      { id: 'e3', title: 'Empty', total_cents: 0, policy_flag_count: 0, status: 'DRAFT', submitted_at: null, created_at: ASOF },
      true,
    );
    expect(draft).toBeNull();
  });

  it('shapes an ON_HOLD bill with the stitched vendor name', () => {
    const item = buildBillHoldItem(
      ASOF,
      { id: 'b1', bill_number: 'INV-9', total_cents: 12345, payment_hold_reason: 'Missing COI', vendor_id: 'v1', created_at: '2026-08-01' },
      'Acme Co',
    );
    expect(item.type).toBe('POLICY_BLOCK');
    expect(item.title).toBe('Acme Co — INV-9');
    expect(item.subtitle).toBe('Missing COI');
    expect(item.actionLabel).toBe('Resolve');
  });

  it('shapes an AI proposal, escalating BLOCKED/ESCALATE dispositions', () => {
    const routine = buildAiProposalItem(ASOF, {
      id: 'p1', feature: 'BANK_CATEGORIZE', input_summary: 'Categorize $50', confidence: 0.62,
      proposed_output: { disposition: 'REVIEW' }, created_at: ASOF,
    });
    expect(routine.type).toBe('EXCEPTION');
    expect(routine.severity).toBe('MEDIUM');
    expect(routine.subtitle).toContain('62% confidence');

    const escalated = buildAiProposalItem(ASOF, {
      id: 'p2', feature: 'ANOMALOUS_JE', input_summary: 'Odd JE', confidence: 0.2,
      proposed_output: { disposition: 'ESCALATE' }, created_at: ASOF,
    });
    expect(escalated.severity).toBe('HIGH');
  });

  it('shapes an overdue obligation into a CRITICAL alert', () => {
    const o = makeObligation(ASOF, {
      type: 'COVENANT', category: 'TEST', title: 'DSCR test', subtitle: 'Bank of X',
      dueDate: '2026-07-20', amountCents: null, entityId: 'c1', href: '/covenants?focus=c1',
    })!;
    const item = buildObligationItem(o);
    expect(item.type).toBe('ALERT');
    expect(item.severity).toBe('CRITICAL');
    expect(item.dueOrAge).toBe('13d overdue');
    expect(item.actionHref).toBe('/covenants?focus=c1');
    expect(item.sortValue).toBe(-13); // days-until-due; more overdue sorts first
  });

  it('shapes an unposted manual JE draft', () => {
    const item = buildJeDraftItem(ASOF, {
      id: 'j1', entry_number: 'JE-100', memo: 'Accrual', source_module: 'MANUAL', created_at: '2026-08-01',
    });
    expect(item.type).toBe('DRAFT');
    expect(item.severity).toBe('LOW');
    expect(item.title).toBe('JE-100 — Accrual');
    expect(item.actionLabel).toBe('Post');
  });
});

// ---------------------------------------------------------------------------
// Ranking + grouping + counts
// ---------------------------------------------------------------------------

function sample(): InboxItem[] {
  return [
    buildJeDraftItem(ASOF, { id: 'j1', entry_number: 'JE-1', memo: null, source_module: 'MANUAL', created_at: '2026-08-01' }),
    buildAiProposalItem(ASOF, { id: 'p1', feature: 'X', input_summary: 'prop', confidence: 0.5, proposed_output: { disposition: 'REVIEW' }, created_at: ASOF }),
    buildObligationItem(
      makeObligation(ASOF, { type: 'INSURANCE', category: 'RENEWAL', title: 'GL renewal', subtitle: null, dueDate: '2026-08-05', amountCents: null, entityId: 'i1', href: '/insurance' })!,
    ),
    buildBillHoldItem(ASOF, { id: 'b1', bill_number: 'INV-1', total_cents: 100, payment_hold_reason: null, vendor_id: null, created_at: ASOF }),
    buildApprovalItem(ASOF, { id: 'a1', kind: 'AP_BATCH', subject_table: null, amount_cents: 100, created_at: ASOF }, false),
  ];
}

describe('rankInboxItems', () => {
  it('orders approvals + blocks first, then alerts, exceptions, drafts', () => {
    const order = rankInboxItems(sample()).map((i) => i.type);
    expect(order).toEqual(['APPROVAL', 'POLICY_BLOCK', 'ALERT', 'EXCEPTION', 'DRAFT']);
  });

  it('within alerts, the most overdue sorts first', () => {
    const overdue = buildObligationItem(
      makeObligation(ASOF, { type: 'LEASE', category: 'MATURITY', title: 'Overdue lease', subtitle: null, dueDate: '2026-07-01', amountCents: null, entityId: 'L1', href: '/leases' })!,
    );
    const soon = buildObligationItem(
      makeObligation(ASOF, { type: 'LEASE', category: 'MATURITY', title: 'Soon lease', subtitle: null, dueDate: '2026-08-20', amountCents: null, entityId: 'L2', href: '/leases' })!,
    );
    const order = rankInboxItems([soon, overdue]).map((i) => i.entity.id);
    expect(order).toEqual(['L1', 'L2']);
  });

  it('is a pure copy — does not mutate input order', () => {
    const items = sample();
    const before = items.map((i) => i.id);
    rankInboxItems(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });
});

describe('groupInboxItems + counts', () => {
  it('groups into ordered non-empty sections', () => {
    const groups = groupInboxItems(sample());
    expect(groups.map((g) => g.key)).toEqual(['APPROVALS', 'POLICY_BLOCKS', 'ALERTS', 'EXCEPTIONS', 'DRAFTS']);
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
  });

  it('countsByType tallies each type', () => {
    const counts = countsByType(sample());
    expect(counts).toEqual({ APPROVAL: 1, POLICY_BLOCK: 1, ALERT: 1, EXCEPTION: 1, DRAFT: 1 });
  });

  it('GROUP_FOR_TYPE maps every type', () => {
    expect(GROUP_FOR_TYPE.APPROVAL).toBe('APPROVALS');
    expect(GROUP_FOR_TYPE.DRAFT).toBe('DRAFTS');
  });
});

// ---------------------------------------------------------------------------
// Loader — degrade isolation
// ---------------------------------------------------------------------------

type FakeResult = { data: unknown[]; error: { message: string } | null };

/**
 * Minimal chainable + thenable Supabase stub. Every query method returns the same
 * builder; awaiting resolves the configured result (or throws for 'throw'). Unknown
 * tables resolve to an empty set so unrelated sources (obligations) stay quiet.
 */
function makeFakeClient(cfg: {
  tables?: Record<string, FakeResult | 'throw'>;
  coreTables?: Record<string, FakeResult>;
}): SupabaseClient {
  const resolve = (map: Record<string, FakeResult | 'throw'> | undefined, table: string): FakeResult => {
    const v = map?.[table];
    if (v === 'throw') throw new Error(`boom:${table}`);
    return v ?? { data: [], error: null };
  };
  const makeBuilder = (getResult: () => FakeResult) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not', 'gte', 'maybeSingle', 'single']) {
      b[m] = chain;
    }
    b.then = (onF: (v: FakeResult) => unknown, onR?: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(getResult()).then(onF, onR);
      } catch (e) {
        return Promise.reject(e).then(onF, onR);
      }
    };
    return b;
  };
  const client = {
    from: (table: string) => makeBuilder(() => resolve(cfg.tables, table)),
    schema: (_s: string) => ({
      from: (table: string) => makeBuilder(() => resolve(cfg.coreTables, table)),
    }),
  };
  return client as unknown as SupabaseClient;
}

describe('collectInbox loader — source degrade isolation', () => {
  it('degrades a broken source and still returns the others', async () => {
    const client = makeFakeClient({
      tables: {
        approvals: 'throw', // this source blows up
        bills: { data: [{ id: 'b1', bill_number: 'INV-1', total_cents: 5000, payment_hold_reason: 'Hold', vendor_id: null, created_at: '2026-08-01' }], error: null },
        ai_decisions: { data: [{ id: 'p1', feature: 'X', input_summary: 'prop', confidence: 0.5, proposed_output: null, created_at: '2026-08-01' }], error: null },
        gl_entries: { data: [{ id: 'j1', entry_number: 'JE-1', memo: null, source_module: 'MANUAL', created_at: '2026-08-01', status: 'PENDING' }], error: null },
      },
    });

    const result = await collectInbox(client, { asOf: ASOF, canApproveMoney: true });

    expect(result.degraded).toContain('approvals');
    // The healthy sources still produced items.
    const types = result.items.map((i) => i.type);
    expect(types).toContain('POLICY_BLOCK');
    expect(types).toContain('EXCEPTION');
    expect(types).toContain('DRAFT');
    // Counts + groups are consistent with the surviving items.
    expect(result.counts.total).toBe(result.items.length);
    expect(result.groups.reduce((n, g) => n + g.items.length, 0)).toBe(result.items.length);
  });

  it('returns an empty, non-degraded inbox when every source is quiet', async () => {
    const client = makeFakeClient({});
    const result = await collectInbox(client, { asOf: ASOF, canApproveMoney: false });
    expect(result.items).toEqual([]);
    expect(result.groups).toEqual([]);
    expect(result.counts.total).toBe(0);
    expect(result.degraded).toEqual([]);
  });
});
