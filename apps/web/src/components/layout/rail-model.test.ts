/**
 * The merit-ui rail keeps every behaviour of the old sidebar (Redesign R1):
 * plane filter, the pick-a-client gate, the industry-pack gate, role filtering,
 * the Access entries — plus the More fold and the live inbox count.
 */
import { describe, expect, it } from 'vitest';
import { buildRail, visibleNavGroups, WORKSPACE_SAFE_HREFS } from './rail-model';
import { navigation } from '@/lib/navigation';
import { PLANES } from '@/lib/planes';

const OFF = { dealer: false };
const ALLOW = () => true;
const base = { packs: OFF, hasPermissionData: false, canView: ALLOW };

const hrefs = (groups: ReturnType<typeof visibleNavGroups>) => groups.flatMap((g) => g.items.map((i) => i.href));

describe('rail model — the old sidebar filters', () => {
  it('Books plane with no client picked shows only Home → Dashboard + Inbox (processing is gated)', () => {
    const groups = visibleNavGroups({ ...base, plane: 'books', mustSelectCompany: true });
    expect(groups.map((g) => g.label)).toEqual(['Home']);
    expect(hrefs(groups)).toEqual([...WORKSPACE_SAFE_HREFS]);
  });

  it('Books plane with a client shows the client-books groups in IA order', () => {
    const groups = visibleNavGroups({ ...base, plane: 'books', mustSelectCompany: false });
    expect(groups.map((g) => g.label)).toEqual(PLANES.books.groups.filter((g) => g !== 'Dealer'));
    expect(hrefs(groups)).toContain('/close');
  });

  it('the Dealer group appears only when the pack is on for the client', () => {
    const off = visibleNavGroups({ ...base, plane: 'books', mustSelectCompany: false });
    const on = visibleNavGroups({ ...base, packs: { dealer: true }, plane: 'books', mustSelectCompany: false });
    expect(off.some((g) => g.label === 'Dealer')).toBe(false);
    expect(on.some((g) => g.label === 'Dealer')).toBe(true);
  });

  it('the Team & settings plane keeps the Access entries and no processing', () => {
    const groups = visibleNavGroups({ ...base, plane: 'practice', mustSelectCompany: false });
    const h = hrefs(groups);
    for (const a of ['/settings/roles', '/settings/access/requests', '/settings/access/reviews', '/settings/access/log', '/team']) {
      expect(h).toContain(a);
    }
    expect(h).not.toContain('/bank-feed');
    expect(h).not.toContain('/journal-entries');
  });

  it('the Platform plane is the operator console only', () => {
    expect(hrefs(visibleNavGroups({ ...base, plane: 'platform', mustSelectCompany: false }))).toEqual(['/platform']);
  });

  it('role permissions filter mapped items (fail-safe when data is unusable)', () => {
    const denyBills = (f: string) => f !== 'bills';
    const groups = visibleNavGroups({ ...base, hasPermissionData: true, canView: denyBills, plane: 'books', mustSelectCompany: false });
    expect(hrefs(groups)).not.toContain('/bills');
    const failSafe = visibleNavGroups({ ...base, hasPermissionData: false, canView: () => false, plane: 'books', mustSelectCompany: false });
    expect(hrefs(failSafe)).toContain('/bills');
  });
});

describe('rail model — Team performance from the Books plane (1G-4)', () => {
  it('a supervisor working in a client\'s books reaches Team performance', () => {
    const h = hrefs(visibleNavGroups({ ...base, hasPermissionData: true, canView: ALLOW, plane: 'books', mustSelectCompany: false }));
    expect(h).toContain('/team?tab=performance');
    // In the Team & settings plane it is the Performance tab of "Team & access" (/team) —
    // one nav entry per route (navigation.test: hrefs are unique).
    expect(hrefs(visibleNavGroups({ ...base, plane: 'practice', mustSelectCompany: false }))).toContain('/team');
  });
  it('roles without team:view never see it (filtered by the page\'s feature)', () => {
    const noTeam = (f: string) => f !== 'team';
    expect(hrefs(visibleNavGroups({ ...base, hasPermissionData: true, canView: noTeam, plane: 'books', mustSelectCompany: false }))).not.toContain('/team?tab=performance');
    expect(hrefs(visibleNavGroups({ ...base, hasPermissionData: true, canView: noTeam, plane: 'practice', mustSelectCompany: false }))).not.toContain('/team?tab=performance');
  });
  it('not before a client is picked (processing gate unchanged)', () => {
    expect(hrefs(visibleNavGroups({ ...base, plane: 'books', mustSelectCompany: true }))).not.toContain('/team?tab=performance');
  });
});

describe('rail model — merit-ui shape', () => {
  it('folds M items behind More, and carries the live inbox count on Inbox', () => {
    const rail = buildRail({ ...base, plane: 'books', mustSelectCompany: false, context: 'client', counts: { inbox: 12, inboxAlert: true } });
    const cash = rail.find((g) => g.id === 'cash-debt');
    expect(cash?.more.map((i) => i.href)).toEqual(['/subscriptions']);
    const inbox = rail.flatMap((g) => g.items).find((i) => i.href === '/inbox');
    expect(inbox?.count).toBe(12);
    expect(inbox?.alert).toBe(true);
  });

  it('every href in the rail exists in lib/navigation (no invented routes)', () => {
    const known = new Set(navigation.flatMap((g) => g.items.map((i) => i.href)));
    for (const plane of ['books', 'practice', 'platform'] as const) {
      const rail = buildRail({ ...base, packs: { dealer: true }, plane, mustSelectCompany: false, context: 'client' });
      for (const it of rail.flatMap((g) => [...g.items, ...g.more])) expect(known.has(it.href)).toBe(true);
    }
  });
});
