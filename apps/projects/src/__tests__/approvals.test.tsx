/**
 * Approvals engine — app side: the default-tier mirror (company size → chain), error copy,
 * labels, inbox shaping, the phone API's query parsing, and an SSR smoke of the inbox,
 * decision panel, delegation and policy screens (merit-ui asserts banned copy and hotkey
 * conflicts in dev).
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MeritProvider } from '@meritbooks/merit-ui';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/approvals',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('server-only', () => ({}));

import { ShellProvider } from '@/components/shell/ShellContext';
import { ApprovalInbox } from '@/components/approvals/ApprovalInbox';
import { ApprovalPanel } from '@/components/approvals/ApprovalPanel';
import { DelegationView } from '@/components/approvals/DelegationView';
import { PolicyView } from '@/components/approvals/PolicyView';
import { DEFAULT_RULES, ROLE_SETS, defaultChain, sizeForCount } from '@/lib/approvals/defaults';
import { approvalErrorCopy } from '@/lib/approvals/errors';
import { decideToast, dueText, itemStatus, rolesLine } from '@/lib/approvals/labels';
import { bulkAllowed, dueGroup, filterItems, groupByDue, typeCounts, visibleTotal } from '@/lib/approvals/filter';
import { APPROVAL_OBJECT_TYPES, isObjectType, type ApprovalItem } from '@/lib/approvals/types';
import { BulkBody, DecideBody, InboxQuery, RejectBody } from '@/app/api/approvals/schemas';
import type { Vocabulary } from '@/lib/pm/vocab';

const A = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-24T15:00:00Z');

const item = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  id: '22222222-2222-4222-8222-222222222222', object_type: 'commitment', object_id: '33333333-3333-4333-8333-333333333333', object_ref: null,
  location_id: A, company: 'Heartland Heating', job_id: null, job_label: '1042 · Smith remodel', title: 'PO-HH-2026-0007 · Lumber', summary: 'Prairie Lumber',
  href: '/jobs/x?tab=commitments', status: 'PENDING', amount_cents: 500_000, money_visible: true, facts: { over_budget: false }, facts_money: { overrun_cents: 0 },
  step: 1, step_count: 1, round: 1, step_label: 'Project manager', escalated: false, due_at: '2026-10-26T15:00:00Z', overdue: false,
  submitted_at: '2026-10-24T14:00:00Z', submitted_by: 'Dana Lee', prepared_by: 'Dana Lee', decided_at: null, decided_by: null, reject_reason: null,
  can_act: true, on_behalf_of: null, self_approval: false, bulk_ok: true, needs_reason: false, sod_exception: false, mine: false, ...over,
});

function wrap(el: ReactElement): string {
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab: { ...DEFAULT_VOCAB } as Vocabulary, companies: [], activeCompanyId: A, readOnly: false, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  );
}

describe('default tiers by company size (spec §2c rule 4)', () => {
  it('sizes people into the four buckets', () => {
    expect([1, 5, 6, 20, 21, 50, 51].map(sizeForCount)).toEqual(['xs', 'xs', 's', 's', 'm', 'm', 'l']);
  });
  it('every bucket covers every seeded object for every amount (no gap in the bands)', () => {
    for (const size of ['xs', 's', 'm', 'l'] as const) {
      for (const t of ['commitment', 'change_order', 'budget_transfer', 'time_entry', 'draw', 'billing_request', 'dealer_deal'] as const) {
        for (const amt of [0, 1, 250_000, 250_001, 1_000_000, 1_000_001, 5_000_001, 25_000_001, 999_999_999]) {
          expect(defaultChain(size, t, amt).length, `${size} ${t} ${amt}`).toBeGreaterThan(0);
        }
      }
    }
  });
  it('POs route upward with the amount (21–50 people: PUR ≤ $2.5k, PM ≤ $25k, GM ≤ $100k, owner above)', () => {
    const labels = (c: number) => defaultChain('m', 'commitment', c).map((s) => s.label);
    expect(labels(250_000)).toEqual(['Purchasing']);
    expect(labels(250_001)).toEqual(['Project manager']);
    expect(labels(2_500_000)).toEqual(['Project manager']);
    expect(labels(10_000_000)).toEqual(['General manager']);
    expect(labels(10_000_001)).toEqual(['Owner']);
    expect(defaultChain('m', 'commitment_change', 10_000_001).map((s) => s.label)).toEqual(['Owner']);
  });
  it('conditional steps: over budget, below the floor, overtime; identical steps collapse', () => {
    expect(defaultChain('s', 'commitment', 500_000, { over_budget: true }).map((s) => s.label)).toEqual(['Project manager', 'Owner']);
    expect(defaultChain('s', 'commitment', 5_000_000, { over_budget: true }).map((s) => s.label)).toEqual(['Owner']);
    expect(defaultChain('l', 'commitment', 6_000_000, { over_budget: true }).map((s) => s.label)).toEqual(['General manager', 'Controller']);
    expect(defaultChain('m', 'change_order', 1, { below_margin_floor: true }).map((s) => s.label)).toEqual(['Project manager', 'General manager']);
    expect(defaultChain('l', 'change_order', 6_000_000, { below_margin_floor: true }).map((s) => s.label)).toEqual(['Project manager', 'General manager']);
    expect(defaultChain('l', 'time_entry', 0, { overtime: true }).map((s) => s.label)).toEqual(['Foreman', 'Project manager', 'General manager']);
    expect(defaultChain('xs', 'estimate', 100)).toEqual([]);
    expect(defaultChain('l', 'estimate', 100, { below_margin_floor: true }).map((s) => s.label)).toEqual(['Sales manager', 'General manager']);
  });
  it('draws: PM, then project accountant, then owner (the lender stays outside the internal chain)', () => {
    expect(defaultChain('xs', 'draw', 1).map((s) => s.label)).toEqual(['Owner']);
    expect(defaultChain('s', 'draw', 1).map((s) => s.label)).toEqual(['Project manager', 'Owner']);
    expect(defaultChain('l', 'draw', 1).map((s) => s.label)).toEqual(['Project manager', 'Project accountant', 'Owner']);
  });
  it('the owner is on every ladder, and every rule names a known ladder', () => {
    for (const [set, roles] of Object.entries(ROLE_SETS)) if (set !== 'ANY') expect(roles, set).toContain('projects_owner');
    for (const r of DEFAULT_RULES) expect(Object.keys(ROLE_SETS)).toContain(r.set);
  });
});

describe('error copy', () => {
  it('keeps the engine sentence and maps the status', () => {
    expect(approvalErrorCopy({ code: '42501', message: 'PM_SOD_VIOLATION: The person who prepares a bill, payment, journal entry or payroll run can never approve it.' }))
      .toEqual({ status: 403, error: 'The person who prepares a bill, payment, journal entry or payroll run can never approve it.', code: 'PM_SOD_VIOLATION' });
    expect(approvalErrorCopy({ code: '22023', message: 'PM_APPROVAL_REASON: say why you are sending it back' }))
      .toEqual({ status: 422, error: 'Say why you are sending it back.', code: 'PM_APPROVAL_REASON' });
    expect(approvalErrorCopy({ code: '42501', message: 'PM_APPROVAL_REQUIRED: this commitment goes through Approvals' })?.status).toBe(409);
    expect(approvalErrorCopy({ code: 'P0001', message: 'PRECONDITION_FAILED: PRECONDITION_NO_LINES' })).toBeNull();
    expect(approvalErrorCopy({ code: '42501', message: 'PM_FORBIDDEN: approval request not found' })).toBeNull();
  });
});

describe('labels and inbox shaping', () => {
  it('status is a pip + word, never colour alone', () => {
    expect(itemStatus(item())).toEqual({ kind: 'risk', word: 'Needs you' });
    expect(itemStatus(item({ can_act: false }))).toEqual({ kind: 'track', word: 'Waiting' });
    expect(itemStatus(item({ step: 2, step_count: 3 }))).toEqual({ kind: 'risk', word: 'Step 2 of 3' });
    expect(itemStatus(item({ overdue: true }))).toEqual({ kind: 'overdue', word: 'Overdue' });
    expect(itemStatus(item({ escalated: true, overdue: true }))).toEqual({ kind: 'overdue', word: 'Escalated' });
    expect(itemStatus(item({ status: 'REJECTED' }))).toEqual({ kind: 'blocked', word: 'Sent back' });
  });
  it('due text and groups against a clock', () => {
    expect(dueText('2026-10-26T15:00:00Z', NOW)).toBe('Due in 2 days');
    expect(dueText('2026-10-25T15:00:00Z', NOW)).toBe('Due tomorrow');
    expect(dueText('2026-10-22T15:00:00Z', NOW)).toBe('2 days overdue');
    expect(dueText(null, NOW)).toBe('—');
    expect(dueGroup(item({ overdue: true }), NOW)).toBe('overdue');
    expect(dueGroup(item({ due_at: '2026-10-24T16:00:00Z' }), NOW)).toBe('today');
    const g = groupByDue([item({ id: 'a', overdue: true }), item({ id: 'b' }), item({ id: 'c', overdue: true })], NOW);
    expect(g.map((x) => [x.id, x.rows.length])).toEqual([['overdue', 2], ['later', 1]]);
  });
  it('toasts say what happened: approved, my step, sent on', () => {
    expect(decideToast({ status: 'approved', title: 'CO-7', waiting_on: null, message: null })).toBe('Approved CO-7');
    expect(decideToast({ status: 'pending', title: 'CO-7', waiting_on: 'General manager', message: null })).toBe('Approved your step — now with General manager');
    expect(decideToast({ status: 'submitted', title: 'CO-7', waiting_on: 'Owner', message: null })).toBe('Sent to Owner for approval');
  });
  it('filters, counts types, totals only visible money, and allows bulk only when every row does', () => {
    const rows = [item({ id: 'a' }), item({ id: 'b', object_type: 'draw', title: 'Draw #3', bulk_ok: false, amount_cents: null }), item({ id: 'c', overdue: true })];
    expect(filterItems(rows, { types: ['draw'] }).map((r) => r.id)).toEqual(['b']);
    expect(filterItems(rows, { text: 'draw #3' }).map((r) => r.id)).toEqual(['b']);
    expect(filterItems(rows, { overdueOnly: true }).map((r) => r.id)).toEqual(['c']);
    expect(typeCounts(rows)).toEqual([{ type: 'commitment', count: 2 }, { type: 'draw', count: 1 }]);
    expect(visibleTotal(rows)).toEqual({ cents: 1_000_000, hidden: 1 });
    expect(bulkAllowed([rows[0]!, rows[2]!])).toBe(true);
    expect(bulkAllowed(rows)).toBe(false);
    expect(bulkAllowed([])).toBe(false);
    expect(rolesLine([])).toBe('Anyone who can approve this');
    expect(rolesLine(['projects_pm', 'projects_owner'])).toBe('Project manager, Owner');
  });
});

describe('API contract (phone app)', () => {
  it('GET ?mine, type lists and filters parse; unknown tabs are refused', () => {
    expect(InboxQuery.parse({ mine: '' })).toEqual({ mine: '' });
    expect(InboxQuery.safeParse({ tab: 'everything' }).success).toBe(false);
    expect(InboxQuery.parse({ tab: 'waiting', overdue: '1', limit: '50' })).toMatchObject({ tab: 'waiting', overdue: '1', limit: 50 });
    expect('change_order,draw,nope'.split(',').filter(isObjectType)).toEqual(['change_order', 'draw']);
    expect(APPROVAL_OBJECT_TYPES).toHaveLength(10);
  });
  it('POST bodies: reject needs a reason; bulk is capped; decide takes a type and id', () => {
    expect(RejectBody.safeParse({ reason: '' }).success).toBe(false);
    expect(RejectBody.parse({ reason: 'Wrong job' })).toEqual({ reason: 'Wrong job', channel: 'web' });
    expect(BulkBody.safeParse({ ids: [], decision: 'approve' }).success).toBe(false);
    expect(BulkBody.safeParse({ ids: Array.from({ length: 101 }, () => A), decision: 'approve' }).success).toBe(false);
    expect(DecideBody.parse({ objectType: 'stage_transition', objectId: A, ref: 'closed', channel: 'phone' })).toMatchObject({ decision: 'approve', ref: 'closed', channel: 'phone' });
    expect(DecideBody.safeParse({ objectType: 'invoice', objectId: A }).success).toBe(false);
  });
});

describe('screens render (SSR)', () => {
  it('the inbox renders every tab, populated and empty', () => {
    const counts = { mine: 2, mine_overdue: 1, waiting: 0 };
    const html = wrap(<ApprovalInbox tab="mine" items={[item(), item({ id: 'b', overdue: true, amount_cents: null, money_visible: false })]} counts={counts} showAll readOnly={false} where="Heartland Heating" />);
    expect(html).toContain('Needs me');
    expect(html).toContain('Waiting on others');
    expect(html).toContain('PO-HH-2026-0007');
    expect(html).toContain('Overdue');
    for (const tab of ['mine', 'waiting', 'decided', 'all'] as const) {
      expect(wrap(<ApprovalInbox tab={tab} items={[]} counts={counts} showAll readOnly={false} where="Heartland Heating" />)).toMatch(/Nothing|No /);
    }
  });
  it('the decision panel shows the verbs only to someone who can act', () => {
    const can = wrap(<ApprovalPanel item={item({ facts: { over_budget: true }, facts_money: { overrun_cents: 125_000 } })} canAct busy={false} onClose={() => {}} onApprove={() => {}} onReject={() => {}} onChanged={() => {}} />);
    expect(can).toContain('Approve');
    expect(can).toContain('Send back');
    expect(can).toContain('Over budget');
    const self = wrap(<ApprovalPanel item={item({ self_approval: true })} canAct busy={false} onClose={() => {}} onApprove={() => {}} onReject={() => {}} onChanged={() => {}} />);
    expect(self).toContain('Approve with reason');
    const view = wrap(<ApprovalPanel item={item({ can_act: false, mine: true })} canAct={false} busy={false} onClose={() => {}} onApprove={() => {}} onReject={() => {}} onChanged={() => {}} />);
    expect(view).not.toContain('Send back');
    expect(view).toContain('Withdraw');
  });
  it('delegation and policy screens render', () => {
    const d = wrap(<DelegationView mine={{ me: A, outgoing: [], incoming: [], managed: [] }} candidates={[{ membership_id: A, name: 'Sam GM', roles: ['projects_gm'], management: true }]} canManage readOnly={false} />);
    expect(d).toContain('Who covers you');
    expect(d).toContain('You have no cover set up');
    const p = wrap(<PolicyView
      policy={{ location_id: A, company: 'Heartland Heating', people: 9, suggested_size: 's', can_configure: true,
        settings: { location_id: A, size_bucket: 's', solo_mode: false, margin_floor_pct: 0.15, escalation_roles: ['projects_gm', 'projects_owner'], seeded_at: null },
        rules: [{ id: A, location_id: A, object_type: 'commitment', policy_key: null, min_amount_cents: 0, max_amount_cents: 1_000_000, step_order: 1, role_set: 'PM',
          approver_roles: ['projects_gm', 'projects_owner', 'projects_pm'], approver_capability: null, min_approver_limit_cents: null, require_distinct: true, due_days: 2,
          condition: null, label: 'Project manager', source: 'default', is_active: true }] }}
      exceptions={[]} showExceptions readOnly={false} />);
    expect(p).toContain('Company size');
    expect(p).toContain('Up to');
    expect(p).toContain('No self-approvals');
  });
});
