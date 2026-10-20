import { describe, expect, it } from 'vitest';
import { DEFAULT_VOCAB, type ModuleKey } from '@meritbooks/industry-packs';
import { railNav, type NavInput } from '@/lib/nav';
import { resolveModules } from '@/lib/pm/modules';
import { vocabularyFrom } from '@/lib/pm/vocab';

const base: NavInput = { context: 'client', vocab: { ...DEFAULT_VOCAB }, modules: [], booksPresent: true, companyCount: 1 };
const labels = (i: Partial<NavInput>) => railNav({ ...base, ...i }).flatMap((g) => [...g.items, ...g.more].map((x) => x.label));
const hrefs = (i: Partial<NavInput>) => railNav({ ...base, ...i }).flatMap((g) => [...g.items, ...g.more].map((x) => x.href));

describe('modules → rail gating', () => {
  it('core entries show with no modules; module entries do not', () => {
    const h = hrefs({ modules: [] });
    expect(h).toEqual(expect.arrayContaining(['/', '/inbox', '/review', '/jobs', '/activity', '/settings', '/wip']));
    for (const gated of ['/schedule', '/dispatch', '/production', '/commitments', '/billing', '/draws', '/change-orders', '/selections', '/estimates', '/job-cost']) {
      expect(h).not.toContain(gated);
    }
  });

  it('a remodeler sees selections and schedule, not dispatch or production', () => {
    const h = hrefs({ modules: ['budget', 'schedule', 'change_orders', 'selections', 'allowances'] });
    expect(h).toEqual(expect.arrayContaining(['/schedule', '/change-orders', '/selections', '/job-cost']));
    expect(h).not.toContain('/dispatch');
    expect(h).not.toContain('/production');
  });

  it('field service sees dispatch and work orders, in its own words', () => {
    const vocab = vocabularyFrom([{ location_id: 'c1', vocab_key: 'work_orders', label: 'Service calls' }, { location_id: 'c1', vocab_key: 'work_order', label: 'Service call' }], 'c1');
    const l = labels({ modules: ['dispatch', 'time', 'service_agreements'], vocab });
    expect(l).toEqual(expect.arrayContaining(['Dispatch', 'Service calls', 'Time']));
    expect(l).not.toContain('Production');
  });

  it('ETO shows production; lender draws show Draws', () => {
    expect(hrefs({ modules: ['production'] })).toContain('/production');
    expect(hrefs({ modules: ['lender_draws'] })).toContain('/draws');
  });

  it('a module item with open work shows even without the module', () => {
    expect(hrefs({ modules: [], counts: { overdueTasks: 3 } })).toContain('/schedule');
  });

  it('WIP needs Merit Books', () => {
    expect(hrefs({ booksPresent: false })).not.toContain('/wip');
  });

  it('workspace rail: Work and Insights; Compare only with more than one company', () => {
    const one = labels({ context: 'workspace', companyCount: 1 });
    expect(one).toEqual(expect.arrayContaining(['Home', 'Jobs', 'Approvals', 'Margin by job', 'Backlog', 'Onboarding', 'Settings']));
    expect(one).not.toContain('Compare companies');
    expect(one).not.toContain('To review');
    expect(labels({ context: 'workspace', companyCount: 3 })).toContain('Compare companies');
  });

  it('consolidated removes processing (approvals, onboarding), not just disables it', () => {
    const l = labels({ context: 'consolidated', companyCount: 3 });
    expect(l).not.toContain('Approvals');
    expect(l).not.toContain('Onboarding');
    expect(l).toContain('Margin by job');
  });

  it('go-to chords are unique within a rail', () => {
    for (const context of ['client', 'workspace', 'consolidated'] as const) {
      const keys = railNav({ ...base, context, modules: ['schedule', 'change_orders'] as ModuleKey[] }).flatMap((g) => g.items.map((i) => i.keys).filter(Boolean));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('resolveModules', () => {
  it('unions active job types and the plan, ignoring unknown and false keys', () => {
    expect(resolveModules([{ budget: true, schedule: false }, { schedule: true, teleport: true }], { change_orders: true, dispatch: false })).toEqual(['budget', 'schedule', 'change_orders']);
    expect(resolveModules([null, undefined], null)).toEqual([]);
  });
});
