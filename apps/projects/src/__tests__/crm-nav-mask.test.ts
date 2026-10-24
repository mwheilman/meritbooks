/**
 * Leads and Customers on the persona rails (SHARED-RECORDS / Wave 0a §5), and the money masking
 * of the customer 360, the tie-outs, the lead views and the duplicate merge summary.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { DEFAULT_VOCAB, type ModuleKey } from '@meritbooks/industry-packs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canReach, railNav, type NavAccess, type NavInput } from '@/lib/nav';
import { PERSONA_GROUP, type AccessRow, type PersonaKey } from '@/lib/access/types';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { buildAccess } from '@/lib/access/derive';
import { moneyVisFor } from '@/components/money/visibility';
import { allMasked, agingBuckets, booksMoneyFor, daysPastDue, parseBooksMoney, parseRelationship } from '@/lib/crm/c360';
import { CHECKS, checkDef, companySummary, figureText, fixAction, jobSummary, maskTieout, parseTieout, seesCheck } from '@/lib/crm/tieout';
import { buildLeadViews } from '@/lib/crm/build';
import { choicesPayload, defaultChoices, differingFields, mergeSummary, moveList, suggestSurvivor, type PartyRecord } from '@/lib/crm/merge';
import type { Pipeline } from '@/lib/crm/types';

const MODS: ModuleKey[] = ['estimates', 'budget', 'schedule', 'change_orders', 'commitments', 'billing', 'time', 'dispatch'];
const nav = (p: PersonaKey): NavAccess => ({ group: PERSONA_GROUP[p], grants: PERSONA_TEMPLATE_GRANTS[p] });
const base: NavInput = { context: 'client', vocab: { ...DEFAULT_VOCAB }, modules: MODS, booksPresent: true, companyCount: 1 };
const hrefs = (p: PersonaKey, i: Partial<NavInput> = {}) => railNav({ ...base, ...i, access: nav(p) }).flatMap((g) => [...g.items, ...g.more].map((x) => x.href));

describe('Leads and Customers on the rails', () => {
  it('management, admin and sales rails carry Leads and Customers', () => {
    for (const p of ['projects_owner', 'projects_gm', 'projects_office_manager', 'projects_dispatcher', 'projects_sales'] as const) {
      expect(hrefs(p), p).toEqual(expect.arrayContaining(['/leads', '/customers']));
    }
  });
  it('the PM rail carries Customers; Leads only with the grant', () => {
    expect(hrefs('projects_pm')).toContain('/customers');
    expect(hrefs('projects_pm')).not.toContain('/leads');
    const withLeads: NavAccess = { group: 'pm', grants: new Set([...PERSONA_TEMPLATE_GRANTS.projects_pm, 'projects.leads:view']) };
    expect(railNav({ ...base, access: withLeads }).flatMap((g) => g.items.map((x) => x.href))).toContain('/leads');
  });
  it('Labor and Supervisor rails do not', () => {
    for (const p of ['projects_labor', 'projects_supervisor'] as const) {
      expect(hrefs(p)).not.toContain('/leads');
      expect(hrefs(p)).not.toContain('/customers');
    }
  });
  it('Leads is not tied to a pack module: it shows without the estimates module', () => {
    expect(hrefs('projects_sales', { modules: ['schedule'] })).toContain('/leads');
  });
  it('management keeps both in the workspace roll-up', () => {
    expect(hrefs('projects_owner', { context: 'workspace', companyCount: 3 })).toEqual(expect.arrayContaining(['/leads', '/customers']));
  });
  it('page guards: /customers and its pages need customers:view; /leads needs leads:view', () => {
    expect(canReach(nav('projects_labor'), '/customers')).toBe(false);
    expect(canReach(nav('projects_labor'), '/customers/duplicates')).toBe(false);
    expect(canReach(nav('projects_pm'), '/customers/abc')).toBe(true);
    expect(canReach(nav('projects_pm'), '/leads/abc')).toBe(false);
    expect(canReach(nav('projects_sales'), '/leads/abc')).toBe(true);
  });
});

// ------------------------------------------------------------------ masking

const L1 = '11111111-1111-4111-8111-111111111111';
function access(p: PersonaKey, loc = L1) {
  const byCap = new Map<string, string[]>();
  for (const g of PERSONA_TEMPLATE_GRANTS[p]) {
    const [cap, action] = g.split(':') as [string, string];
    byCap.set(cap, [...(byCap.get(cap) ?? []), action]);
  }
  const rows: AccessRow[] = [...byCap].map(([capability, actions]) => ({ location_id: loc, capability, actions, role_key: p, role_name: null }));
  return buildAccess(rows);
}

describe('customer 360 Books money', () => {
  const row = {
    customer_id: 'c', open_ar_cents: 125_000, overdue_ar_cents: '50000', deposits_held_cents: 20_000, lifetime_billed_cents: 900_000,
    last_invoice_on: '2026-10-01', last_payment_on: null,
    invoices: [{ id: 'i1', number: 'INV-1', date: '2026-09-01', due_date: '2026-09-15', total_cents: 75_000, balance_cents: 50_000, status: 'SENT' }, { id: 'i2', due_date: '2026-11-01', balance_cents: 75_000 }, { nope: 1 }],
    payments: JSON.stringify([{ id: 'p1', date: '2026-09-20', amount_cents: 25_000, method: 'ACH' }]),
    deposits: [{ id: 'd1', amount_cents: 20_000, applied_cents: 0 }],
  };
  it('parses the view row (numeric strings, jsonb text, bad items dropped)', () => {
    const m = parseBooksMoney(row)!;
    expect(m.overdueArCents).toBe(50_000);
    expect(m.invoices.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(m.payments[0]!.amountCents).toBe(25_000);
    expect(parseBooksMoney(null)).toBeNull();
  });
  it('drawn only with contract value; absent (null) otherwise, never zeros', () => {
    const m = parseBooksMoney(row);
    expect(booksMoneyFor(m, true)).not.toBeNull();
    expect(booksMoneyFor(m, false)).toBeNull();
    const masked = parseBooksMoney({ ...row, open_ar_cents: null, overdue_ar_cents: null, deposits_held_cents: null, lifetime_billed_cents: null, invoices: [], payments: [] })!;
    expect(allMasked(masked)).toBe(true);
    expect(booksMoneyFor(masked, true)).toBeNull();
  });
  it('which personas see it (contract_value at the company)', () => {
    const sees = (p: PersonaKey) => moneyVisFor(access(p), L1).contract;
    expect(sees('projects_owner')).toBe(true);
    expect(sees('projects_office_manager')).toBe(true);
    expect(sees('projects_sales')).toBe(true);
    expect(sees('projects_dispatcher')).toBe(false);
    expect(sees('projects_labor')).toBe(false);
    expect(sees('projects_supervisor')).toBe(false);
  });
  it('aging buckets and days past due', () => {
    const m = parseBooksMoney(row)!;
    expect(daysPastDue(m.invoices[0]!, '2026-10-24')).toBe(39);
    expect(agingBuckets(m.invoices, '2026-10-24').map((b) => b.cents)).toEqual([75_000, 0, 50_000, 0, 0]);
  });
  it('relationship stage', () => {
    expect(parseRelationship({ customer_id: 'c', stage: 'customer', since: '2025-01-01' })).toEqual({ stage: 'customer', since: '2025-01-01' });
    expect(parseRelationship({ stage: 'vip' })).toBeNull();
  });
});

describe('tie-outs', () => {
  const rows = parseTieout([
    { job_id: 'j1', check_key: 'job_cost', projects_cents: 1_000_000, books_cents: 990_000, diff_cents: 10_000, status: 'exception', cause: 'Bill for $100.00 not coded to the job', action: 'open_bill' },
    { job_id: 'j1', check_key: 'billing', projects_cents: 500_000, books_cents: 500_000, diff_cents: 0, status: 'ok', cause: null, action: null },
    { job_id: 'j1', check_key: 'time', projects_cents: 4000, books_cents: 3800, diff_cents: 200, status: 'exception', cause: null, action: 'approve_time' },
    { job_id: 'j2', check_key: 'deposits', projects_cents: 200_000, books_cents: 100_000, diff_cents: 100_000, status: 'exception', cause: 'x', action: 'resend' },
    { job_id: 'j2', check_key: 'events', projects_cents: 3, books_cents: 2, diff_cents: 1, status: 'pending', cause: null, action: null },
    { job_id: 'bad' },
  ]);
  it('parses rows', () => {
    expect(rows).toHaveLength(5);
  });
  it('money classes per check', () => {
    expect(checkDef('job_cost').money).toBe('cost');
    expect(checkDef('commitments').money).toBe('cost');
    expect(checkDef('billing').money).toBe('contract');
    expect(checkDef('deposits').money).toBe('contract');
    for (const k of ['time', 'events', 'customers']) expect(checkDef(k).money, k).toBeNull();
    expect(CHECKS.map((c) => c.key)).toEqual(['job_cost', 'billing', 'deposits', 'commitments', 'time', 'events', 'customers']);
  });
  it('no money: figures nulled and the cause generalised (the database cause may quote dollars)', () => {
    const none = maskTieout(rows, { cost: false, contract: false });
    const jc = none.find((r) => r.checkKey === 'job_cost')!;
    expect([jc.projects, jc.books, jc.diff]).toEqual([null, null, null]);
    expect(jc.cause).not.toContain('$');
    expect(jc.status).toBe('exception');
    const t = none.find((r) => r.checkKey === 'time')!;
    expect(t.diff).toBe(200);
  });
  it('contract only (office): billing and deposits figures, no cost figures', () => {
    const office = maskTieout(rows, moneyVisFor(access('projects_office_manager'), L1));
    expect(office.find((r) => r.checkKey === 'deposits')!.diff).toBe(100_000);
    expect(office.find((r) => r.checkKey === 'job_cost')!.diff).toBeNull();
    expect(seesCheck(checkDef('job_cost'), { cost: true, contract: false })).toBe(true);
  });
  it('job headline: Ties to Books only when every check is ok', () => {
    expect(jobSummary(rows.filter((r) => r.jobId === 'j1')).headline).toBe('2 checks differ from Books');
    expect(jobSummary(rows.filter((r) => r.checkKey === 'billing'))).toMatchObject({ status: 'ok', headline: 'Ties to Books' });
    expect(jobSummary([]).headline).toBe('Not checked yet');
    expect(jobSummary(rows.filter((r) => r.checkKey === 'events')).headline).toBe('Waiting on Books');
  });
  it('company summary ranks exceptions by dollar difference; masked ones after', () => {
    const s = companySummary(rows);
    expect(s.exceptions.map((r) => `${r.jobId}:${r.checkKey}`)).toEqual(['j2:deposits', 'j1:job_cost', 'j1:time']);
    expect(s.jobsChecked).toBe(2);
    expect(s.jobsTied).toBe(0);
    const masked = companySummary(maskTieout(rows, { cost: false, contract: true }));
    expect(masked.exceptions[0]!.checkKey).toBe('deposits');
    expect(masked.checks.find((c) => c.key === 'job_cost')!.diffAbs).toBeNull();
  });
  it('one fix action per exception', () => {
    expect(fixAction({ action: 'open_bill', checkKey: 'job_cost', jobId: 'j1' })).toEqual({ label: 'Open the bill', href: '/jobs/j1?tab=commitments' });
    expect(fixAction({ action: 'resend', checkKey: 'billing', jobId: 'j1' })!.label).toBe('Resend to Books');
    expect(fixAction({ action: 'approve_time', checkKey: 'time', jobId: 'j1' })!.href).toBe('/time?job=j1');
    expect(fixAction({ action: null, checkKey: 'customers', jobId: 'j1' })!.href).toBe('/customers/duplicates');
    expect(fixAction({ action: '/billing?x=1', checkKey: 'billing', jobId: 'j1' })!.href).toBe('/billing?x=1');
  });
  it('figures read as dollars, hours or counts', () => {
    const money = (c: number) => `$${(c / 100).toFixed(2)}`;
    expect(figureText(checkDef('job_cost'), 10_000, money)).toBe('$100.00');
    expect(figureText(checkDef('time'), 4050, money)).toBe('40.50 h');
    expect(figureText(checkDef('events'), 3, money)).toBe('3');
    expect(figureText(checkDef('job_cost'), null, money)).toBe('—');
  });
});

describe('lead views are masked per lead company before they leave the server', () => {
  const pipe: Pipeline = {
    id: 'p', org_id: 'o', location_id: L1, key: 'k', name: 'Sales', pack_key: null, is_default: true,
    stages: [{ id: 's1', pipeline_id: 'p', key: 'new', name: 'New', kind: 'open', probability_pct: 20, sort: 1 }],
  };
  const leadRow = {
    id: 'l1', org_id: 'o', location_id: L1, pipeline_id: 'p', stage_id: 's1', title: 'Kitchen', customer_id: null, contact_id: null, site_id: null,
    source: 'web_form', source_detail: null, campaign: null, owner_membership_id: null, estimated_value_cents: 5_000_000, expected_close_on: null,
    next_step: null, next_step_on: null, lost_reason: null, won_at: null, lost_at: null, converted_estimate_id: null, converted_job_id: null,
    created_by: null, created_at: '2026-10-20T14:00:00Z', updated_at: '2026-10-20T14:00:00Z',
  };
  const empty = { data: [], error: null };
  const chain: Record<string, unknown> = {};
  for (const k of ['select', 'in', 'eq', 'is', 'order', 'limit']) chain[k] = () => chain;
  (chain as { then: unknown }).then = (res: (v: typeof empty) => unknown) => Promise.resolve(empty).then(res);
  const db = { schema: () => ({ from: () => chain }) } as unknown as SupabaseClient;
  const view = async (p: PersonaKey) => (await buildLeadViews(db, [leadRow], [pipe], access(p), [{ id: L1, name: 'Co' }], { nowMs: Date.parse('2026-10-20T14:10:00Z'), today: '2026-10-20' }))[0]!;

  it('sales and owner see the value; the dispatcher does not', async () => {
    expect((await view('projects_sales')).amountCents).toBe(5_000_000);
    expect((await view('projects_owner')).amountCents).toBe(5_000_000);
    expect((await view('projects_dispatcher')).amountCents).toBeNull();
  });
  it('the timer runs for an untouched open lead', async () => {
    expect((await view('projects_dispatcher')).speed).toMatchObject({ state: 'waiting', tone: 'risk' });
  });
});

describe('duplicate merge', () => {
  const a: PartyRecord = { id: 'a', name: 'Harbor Holdings', createdAt: '2025-01-01', booksSince: '2025-02-01', fields: { name: 'Harbor Holdings', email: 'ap@harbor.com', phone: null, city: 'Ames' } };
  const b: PartyRecord = { id: 'b', name: 'Harbor Holdings LLC', createdAt: '2024-01-01', booksSince: null, fields: { name: 'Harbor Holdings LLC', email: 'ap@harbor.com', phone: '515-555-0100', city: 'Ames' } };
  it('keeps the record Books has used, else the older one', () => {
    expect(suggestSurvivor(a, b).id).toBe('a');
    expect(suggestSurvivor({ ...a, booksSince: null }, b).id).toBe('b');
  });
  it('per field: the kept value unless it is empty', () => {
    const c = defaultChoices('customer', a, b);
    expect(c.name).toBe('survivor');
    expect(c.phone).toBe('victim');
    expect(differingFields('customer', a, b).map((f) => f.key)).toEqual(expect.arrayContaining(['name', 'phone']));
    expect(differingFields('customer', a, b).map((f) => f.key)).not.toContain('email');
    expect(Object.keys(choicesPayload('customer', c))).toEqual(['name', 'email', 'phone', 'address_line1', 'city', 'state', 'zip']);
  });
  it('a plain summary of what moves', () => {
    expect(moveList({ jobs: 2, leads: 1, contacts: 0 })).toEqual(['2 jobs', '1 lead']);
    const s = mergeSummary('customer', a, b, { jobs: 2, leads: 1 });
    expect(s[0]).toContain('Harbor Holdings is kept');
    expect(s[1]).toBe('Moves to Harbor Holdings: 2 jobs, 1 lead.');
    expect(s.join(' ')).toContain('no amount or date changes');
    expect(mergeSummary('customer', a, b, {})[1]).toContain('Nothing in Merit Projects points');
  });
});
