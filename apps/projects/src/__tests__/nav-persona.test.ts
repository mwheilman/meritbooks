import { describe, expect, it } from 'vitest';
import { DEFAULT_VOCAB, type ModuleKey } from '@meritbooks/industry-packs';
import { canReach, railNav, type NavAccess, type NavInput } from '@/lib/nav';
import { PERSONA_GROUP, type PersonaKey } from '@/lib/access/types';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { moneyVisFromGrants, seesMargin } from '@/components/money/visibility';

const ALL_MODULES: ModuleKey[] = ['estimates', 'budget', 'schedule', 'change_orders', 'selections', 'commitments', 'billing', 'retainage', 'time', 'daily_logs', 'punch_warranty', 'dispatch'];
const as = (p: PersonaKey): NavAccess => ({ group: PERSONA_GROUP[p], grants: PERSONA_TEMPLATE_GRANTS[p] });
const base: NavInput = { context: 'client', vocab: { ...DEFAULT_VOCAB }, modules: ALL_MODULES, booksPresent: true, companyCount: 1 };
const rail = (p: PersonaKey, i: Partial<NavInput> = {}) => railNav({ ...base, ...i, access: as(p) });
const labels = (p: PersonaKey, i: Partial<NavInput> = {}) => rail(p, i).flatMap((g) => [...g.items, ...g.more].map((x) => x.label));
const hrefs = (p: PersonaKey, i: Partial<NavInput> = {}) => rail(p, i).flatMap((g) => [...g.items, ...g.more].map((x) => x.href));

const MONEY_PAGES = ['/billing', '/retainage', '/commitments', '/subcontractors', '/job-cost', '/wip', '/insights/margin'];

describe('rail per persona (spec §5)', () => {
  it('Labor: Today, Time, Jobs, Me — nothing else', () => {
    expect(labels('projects_labor')).toEqual(['Today', 'Time', 'Jobs', 'Me']);
  });

  it('Supervisor: Today, My jobs, Schedule, Crew time, Logs, Punch; no money pages', () => {
    const l = labels('projects_supervisor');
    expect(l.slice(0, 2)).toEqual(['Today', 'My jobs']);
    expect(l).toEqual(expect.arrayContaining(['Schedule', 'Crew time', DEFAULT_VOCAB.daily_logs, 'Punch list']));
    for (const h of MONEY_PAGES) expect(hrefs('projects_supervisor')).not.toContain(h);
  });

  it('PM: Home, My jobs, Schedule, changes, commitments, billing, inbox', () => {
    const h = hrefs('projects_pm');
    expect(h).toEqual(expect.arrayContaining(['/', '/inbox', '/jobs', '/schedule', '/change-orders', '/commitments', '/billing']));
    expect(labels('projects_pm')).toContain('My jobs');
    expect(h).not.toContain('/settings');
  });

  it('Dispatcher (office, no money): jobs and dispatch, no billing, cost or commitments', () => {
    const h = hrefs('projects_dispatcher');
    expect(h).toEqual(expect.arrayContaining(['/', '/jobs', '/dispatch']));
    for (const m of MONEY_PAGES) expect(h).not.toContain(m);
  });

  it('Management: Home, Jobs, Pipeline, Insights, Approvals, Settings', () => {
    const r = rail('projects_owner');
    const l = r.flatMap((g) => [...g.items, ...g.more].map((x) => x.label));
    expect(l).toEqual(expect.arrayContaining(['Home', 'Jobs', 'Approvals', 'Margin by job', 'Settings']));
    expect(r.map((g) => g.label)).toEqual(expect.arrayContaining(['Pipeline', 'Insights']));
  });

  it('items are absent, not greyed: every rendered item is reachable', () => {
    for (const p of Object.keys(PERSONA_GROUP) as PersonaKey[]) {
      for (const h of hrefs(p)) expect(canReach(as(p), h), `${p} → ${h}`).toBe(true);
    }
  });

  it('go-to chords stay unique in every persona rail', () => {
    for (const p of Object.keys(PERSONA_GROUP) as PersonaKey[]) {
      const keys = rail(p).flatMap((g) => g.items.map((i) => i.keys).filter(Boolean));
      expect(new Set(keys).size, p).toBe(keys.length);
    }
  });
});

describe('page reach follows grants at the company in view', () => {
  it('a grant at company A does not open the page at company B', () => {
    const a: NavAccess = { group: 'pm', grants: new Set(['projects.financials:view']), byCompany: { A: new Set(['projects.financials:view']), B: new Set() } };
    expect(canReach(a, '/job-cost', 'A')).toBe(true);
    expect(canReach(a, '/job-cost', 'B')).toBe(false);
  });

  it('money pages need the money they show', () => {
    expect(canReach(as('projects_labor'), '/billing')).toBe(false);
    expect(canReach(as('projects_purchasing'), '/billing')).toBe(false);
    expect(canReach(as('projects_office_manager'), '/job-cost')).toBe(false);
    expect(canReach(as('projects_owner'), '/insights/margin')).toBe(true);
  });
});

describe('money visibility (spec §2.3)', () => {
  it('labor and supervisor see no dollars; PM and owner see both sides', () => {
    for (const p of ['projects_labor', 'projects_supervisor', 'projects_dispatcher'] as PersonaKey[]) {
      const m = moneyVisFromGrants(PERSONA_TEMPLATE_GRANTS[p], 4);
      expect(m.cost || m.contract || m.rates, p).toBe(false);
    }
    expect(seesMargin(moneyVisFromGrants(PERSONA_TEMPLATE_GRANTS.projects_pm, 3))).toBe(true);
    expect(moneyVisFromGrants(PERSONA_TEMPLATE_GRANTS.projects_pm, 3).rates).toBe(false);
    expect(moneyVisFromGrants(PERSONA_TEMPLATE_GRANTS.projects_owner, 4)).toEqual({ cost: true, contract: true, rates: true, level: 4 });
  });

  it('office manager: contract only, so no margin', () => {
    const m = moneyVisFromGrants(PERSONA_TEMPLATE_GRANTS.projects_office_manager, 3);
    expect(m.contract).toBe(true);
    expect(m.cost).toBe(false);
    expect(seesMargin(m)).toBe(false);
  });

  it('the level never exceeds what access derived', () => {
    expect(moneyVisFromGrants(PERSONA_TEMPLATE_GRANTS.projects_owner, 2).level).toBe(2);
  });
});
