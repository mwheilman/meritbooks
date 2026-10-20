import { describe, expect, it } from 'vitest';
import { activeHref, filterNav, navChords, type NavGroup } from '../src/shell/nav';

// The Merit Projects company rail (review 01 §4), trimmed.
const company: NavGroup[] = [
  {
    id: 'home',
    items: [
      { label: 'Home', href: '/', keys: 'g h' },
      { label: 'Inbox', href: '/inbox', count: 4 },
      { label: 'To review', href: '/review', count: 23, capability: 'review.view', processing: true, keys: 'g r' },
    ],
  },
  {
    id: 'jobs',
    label: 'Jobs',
    items: [
      { label: 'Jobs', href: '/jobs', capability: 'jobs.view', keys: 'g j' },
      { label: 'Change orders', href: '/change-orders', capability: 'co.view', count: 6, processing: true },
      { label: 'Selections & allowances', href: '/selections', disclosure: 'A', module: 'selections' },
    ],
  },
  {
    id: 'field',
    label: 'Field',
    items: [
      { label: 'Schedule', href: '/schedule', disclosure: 'A', module: 'field' },
      { label: 'Work orders', href: '/work-orders', disclosure: 'A', module: 'field', count: 3 },
    ],
  },
  {
    id: 'controls',
    label: 'Controls',
    items: [
      { label: 'Audit trail', href: '/audit', capability: 'audit.view' },
      { label: 'AI decisions', href: '/ai-decisions', capability: 'audit.view', disclosure: 'M' },
      { label: 'Exceptions', href: '/exceptions', capability: 'audit.view', disclosure: 'M', count: 2 },
    ],
  },
  { id: 'own-only', label: 'Firm', contexts: ['own'], items: [{ label: 'Management fees', href: '/fees' }] },
];

const all = () => true;

describe('filterNav', () => {
  it('fails closed: capability-gated items are hidden when no `can` is given', () => {
    const out = filterNav(company, { context: 'client' });
    const labels = out.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain('Home');
    expect(labels).not.toContain('To review');
    expect(labels).not.toContain('Jobs');
    expect(out.find((g) => g.id === 'controls')).toBeUndefined(); // empty group disappears
  });

  it('permission first: only granted capabilities render', () => {
    const out = filterNav(company, { context: 'client', can: (c) => c === 'jobs.view' });
    expect(out.find((g) => g.id === 'jobs')?.items.map((i) => i.label)).toEqual(['Jobs']);
  });

  it('removes processing items in a consolidated view (removed, not disabled)', () => {
    const out = filterNav(company, { context: 'consolidated', can: all });
    const labels = out.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).not.toContain('To review');
    expect(labels).not.toContain('Change orders');
    expect(labels).toContain('Jobs');
  });

  it('activation: A items show for modules in use, and never hide while they hold open work', () => {
    const none = filterNav(company, { context: 'client', can: all, modulesInUse: [] });
    expect(none.find((g) => g.id === 'field')?.items.map((i) => i.label)).toEqual(['Work orders']); // count 3 keeps it
    expect(none.find((g) => g.id === 'jobs')?.items.map((i) => i.label)).not.toContain('Selections & allowances');
    const used = filterNav(company, { context: 'client', can: all, modulesInUse: ['field', 'selections'] });
    expect(used.find((g) => g.id === 'field')?.items.map((i) => i.label)).toEqual(['Schedule', 'Work orders']);
  });

  it('More fold: M items fold unless they hold open work; order is stable', () => {
    const out = filterNav(company, { context: 'client', can: all });
    const controls = out.find((g) => g.id === 'controls');
    expect(controls?.items.map((i) => i.label)).toEqual(['Audit trail', 'Exceptions']);
    expect(controls?.more.map((i) => i.label)).toEqual(['AI decisions']);
    const expanded = filterNav(company, { context: 'client', can: all, expandMore: true });
    expect(expanded.find((g) => g.id === 'controls')?.items.map((i) => i.label)).toEqual(['Audit trail', 'AI decisions', 'Exceptions']);
  });

  it('context-limited groups', () => {
    expect(filterNav(company, { context: 'client', can: all }).some((g) => g.id === 'own-only')).toBe(false);
    expect(filterNav(company, { context: 'own', can: all }).some((g) => g.id === 'own-only')).toBe(true);
  });
});

describe('activeHref', () => {
  const groups = filterNav(company, { context: 'client', can: all, modulesInUse: ['field'] });
  it('exact match wins', () => {
    expect(activeHref(groups, '/inbox')).toBe('/inbox');
    expect(activeHref(groups, '/')).toBe('/');
  });
  it('longest prefix on a / boundary (a job page lights Jobs)', () => {
    expect(activeHref(groups, '/jobs/J-1042/budget')).toBe('/jobs');
    expect(activeHref(groups, '/jobsite')).toBeNull();
    expect(activeHref(groups, '/inbox?tab=mentions')).toBe('/inbox');
  });
  it('lists go-to chords', () => {
    expect(navChords(groups).map((c) => c.keys)).toEqual(['g h', 'g r', 'g j']);
  });
});
