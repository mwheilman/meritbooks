/** Wave A integration: approval outcomes, field-service and approvals nav, pack schedule lenses. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_VOCAB, MODULES, compilePlan, resolveVocabulary, type ModuleKey } from '@meritbooks/industry-packs';
import { approvalOutcome, chainPending, timeApprovalText } from '@/lib/approvals/outcome';
import { canReach, railNav, type NavAccess } from '@/lib/nav';
import { PERSONA_GROUP, type PersonaKey } from '@/lib/access/types';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { globalViewFromPack, jobViewFromPack } from '@/lib/pm/schedule/views';
import { MONEY_KEYS } from '@/lib/access/money-keys';

const as = (p: PersonaKey): NavAccess => ({ group: PERSONA_GROUP[p], grants: PERSONA_TEMPLATE_GRANTS[p] });

describe('approve responses say who it waits on', () => {
  it('a chain with steps left is not "Approved"', () => {
    const a = { status: 'pending', waitingOn: 'Pat Lee', step: 2, stepCount: 3 };
    expect(chainPending(a)).toBe(true);
    const t = approvalOutcome(a, 'Approved CO-7', 'CO-7');
    expect(t).not.toMatch(/^Approved/);
    expect(t).toContain('Waiting on Pat Lee');
    expect(approvalOutcome({ status: 'submitted', waitingOn: null }, 'Sent', 'EST-3')).toBe('EST-3: sent for approval · Waiting on the next approver');
  });
  it('a finished chain, or no chain, keeps the done text', () => {
    expect(approvalOutcome({ status: 'approved' }, 'Approved CO-7')).toBe('Approved CO-7');
    expect(approvalOutcome({ status: 'not_needed' }, 'Approved CO-7')).toBe('Approved CO-7');
    expect(approvalOutcome(undefined, 'Approved CO-7')).toBe('Approved CO-7');
    expect(chainPending(null)).toBe(false);
  });
  it('time: approved, waiting and sent on are counted apart', () => {
    expect(timeApprovalText({ approved: 2, pending: 1, sentOn: 1, results: [{ status: 'pending', waitingOn: 'Sam' }] }, 4))
      .toBe('Approved 2 entries · 1 entry waiting on Sam · 1 entry sent on to another approver');
    expect(timeApprovalText({ approved: 0, pending: 3, sentOn: 0, results: [] }, 3)).toBe('3 entries waiting on the next approver');
  });
});

describe('nav: approvals for everyone, field-service screens where they belong', () => {
  const fsPlan = compilePlan({ pack: 'field_service', locationId: '00000000-0000-4000-8000-000000000001' });
  const input = {
    context: 'client' as const, vocab: resolveVocabulary(fsPlan.vocabulary), modules: MODULES.filter((m) => fsPlan.modules[m]) as ModuleKey[],
    booksPresent: true, companyCount: 1, packKeys: ['field_service'], experience: fsPlan.experience, counts: { approvalsMine: 4 },
  };
  const hrefs = (p: PersonaKey) => railNav({ ...input, access: as(p) }).flatMap((g) => [...g.items, ...g.more].map((x) => x.href));

  it('every member may open Approvals (preparers see "Waiting on others"); the rules need settings', () => {
    for (const p of Object.keys(PERSONA_GROUP) as PersonaKey[]) expect(canReach(as(p), '/approvals'), p).toBe(true);
    expect(canReach(as('projects_labor'), '/approvals/policies')).toBe(false);
    expect(canReach(as('projects_owner'), '/approvals/policies')).toBe(true);
    const approvals = railNav({ ...input, access: as('projects_pm') }).flatMap((g) => [...g.items, ...g.more]).find((x) => x.href === '/approvals');
    expect(approvals?.count).toBe(4);
  });

  it('the dispatcher gets Calls, the price book and capacity; nobody without dispatch:edit sees Calls', () => {
    expect(hrefs('projects_dispatcher')).toEqual(expect.arrayContaining(['/calls', '/dispatch', '/pricebook', '/dispatch/capacity']));
    expect(hrefs('projects_sales')).not.toContain('/calls');
    expect(hrefs('projects_labor')).not.toContain('/calls');
  });

  it('the owner reaches scorecards, campaigns, out of office and approval rules', () => {
    expect(hrefs('projects_owner')).toEqual(expect.arrayContaining(['/dispatch/scorecards', '/calls/campaigns', '/approvals/delegation', '/approvals/policies', '/documents']));
  });

  it('a company without dispatch never shows the field-service screens', () => {
    const h = railNav({ context: 'client', vocab: { ...DEFAULT_VOCAB }, modules: ['budget', 'schedule'], booksPresent: true, companyCount: 1, access: as('projects_owner') })
      .flatMap((g) => [...g.items, ...g.more].map((x) => x.href));
    for (const x of ['/calls', '/pricebook', '/dispatch/capacity', '/dispatch/scorecards']) expect(h).not.toContain(x);
  });
});

describe('schedule opens on the pack lens', () => {
  it('job tab', () => {
    expect(jobViewFromPack('gantt', 'field_service')).toBe('gantt');
    expect(jobViewFromPack('dispatch', 'project')).toBe('list');
    expect(jobViewFromPack('milestone_timeline', null)).toBe('gantt');
    expect(jobViewFromPack(null, 'project')).toBe('gantt');
    expect(jobViewFromPack(null, 'field_service')).toBe('list');
  });
  it('global page', () => {
    expect(globalViewFromPack('lookahead')).toEqual({ view: 'lookahead', board: null });
    expect(globalViewFromPack('crew_board').view).toBe('crews');
    expect(globalViewFromPack('dispatch').board?.href).toBe('/dispatch');
    expect(globalViewFromPack(undefined)).toEqual({ view: 'jobs', board: null });
  });
});

describe('option-builder money keys', () => {
  it('sell prices are public like the price book; line cost is financials', () => {
    expect(MONEY_KEYS.fs_estimate.public).toEqual(expect.arrayContaining(['unit_price_cents', 'member_unit_price_cents', 'regular_cents']));
    expect(MONEY_KEYS.fs_estimate.financials).toContain('unit_cost_cents');
  });
});
