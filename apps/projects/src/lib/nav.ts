/**
 * The Merit Projects rail (blueprint §4). Pure: builds the NavGroup tree from the
 * shell context, the company's modules and vocabulary, and cheap counts; merit-ui
 * filterNav() then applies context and module activation (A items show only when
 * the company uses the module, or when they hold open work).
 */
import { filterNav, type FilteredNavGroup, type NavGroup, type NavItem, type ShellContext } from '@meritbooks/merit-ui';
import type { ModuleKey } from '@/lib/packs';
import type { Vocabulary } from '@/lib/pm/vocab';
import { isDealerVocab, woVocab } from '@/lib/pm/ops/labels';

export interface NavCounts {
  openJobs?: number;
  toReview?: number;
  overdueTasks?: number;
}

export interface NavInput {
  context: ShellContext;
  vocab: Vocabulary;
  modules: ReadonlyArray<ModuleKey>;
  counts?: NavCounts;
  booksPresent: boolean;
  companyCount: number;
  /** Primary pack keys of the companies in view (the Store group shows for equipment_dealer). */
  packKeys?: ReadonlyArray<string>;
  /** Archetypes of the active job types in view (dealer_service turns the Store group on). */
  archetypes?: ReadonlyArray<string>;
}

/**
 * The dealership screens are not a pack module: they follow the company being a dealer. This
 * pseudo-module key activates the Store group; a company is a dealer when its pack is
 * equipment_dealer, a job type has archetype dealer_service, or (when the layout passes neither)
 * its pack vocabulary calls the job a repair order.
 */
export const DEALER_STORE_MODULE = 'dealer_store';

export function isDealerNav(i: Pick<NavInput, 'vocab' | 'packKeys' | 'archetypes'>): boolean {
  return (i.packKeys ?? []).includes('equipment_dealer') || (i.archetypes ?? []).includes('dealer_service') || isDealerVocab(i.vocab);
}

function store(label: string, href: string): NavItem {
  return { label, href, disclosure: 'A', module: DEALER_STORE_MODULE };
}

const COMPANY: ReadonlyArray<ShellContext> = ['client'];
const ROLLUP: ReadonlyArray<ShellContext> = ['workspace', 'consolidated'];

function a(label: string, href: string, module: ModuleKey, extra: Partial<NavItem> = {}): NavItem {
  return { label, href, disclosure: 'A', module, ...extra };
}

export function buildNav(i: NavInput): NavGroup[] {
  const v = i.vocab;
  const c = i.counts ?? {};
  const review = c.toReview || undefined;
  const overdue = c.overdueTasks || undefined;
  return [
    {
      id: 'home',
      items: [
        { label: 'Home', href: '/', keys: 'g h' },
        { label: 'Inbox', href: '/inbox' },
        { label: 'To review', href: '/review', keys: 'g r', count: review, processing: true, contexts: COMPANY },
      ],
    },
    // ---- company rail ----
    {
      id: 'store',
      label: 'Store',
      contexts: COMPANY,
      items: [store('Stock', '/stock'), store('Deals', '/deals'), store('Parts', '/parts'), store('Rentals', '/rentals'), store('Warranty', '/warranty')],
    },
    { id: 'sell', label: 'Sell', contexts: COMPANY, items: [a('Leads', '/leads', 'estimates'), a(v.estimates, '/estimates', 'estimates')] },
    {
      id: 'jobs',
      label: v.jobs,
      contexts: COMPANY,
      items: [
        { label: v.jobs, href: '/jobs', keys: 'g j', count: c.openJobs || undefined },
        a(v.change_orders, '/change-orders', 'change_orders', { keys: 'g c' }),
        a(v.selections, '/selections', 'selections'),
        a('Lots and units', '/units', 'lots_units'),
      ],
    },
    {
      id: 'field',
      label: 'Field',
      contexts: COMPANY,
      items: [
        a('Schedule', '/schedule', 'schedule', { keys: 'g s', count: overdue, alert: !!overdue }),
        a('Dispatch', '/dispatch', 'dispatch'),
        a(woVocab(v).many, '/work-orders', 'dispatch'),
        a('Agreements', '/agreements', 'service_agreements'),
        a('Equipment', '/assets', 'assets'),
        a(v.daily_logs, '/daily-logs', 'daily_logs'),
        a('Punch list', '/punch-list', 'punch_warranty'),
        a('Time', '/time', 'time'),
      ],
    },
    { id: 'make', label: 'Make', contexts: COMPANY, items: [a('Production', '/production', 'production')] },
    {
      id: 'buy',
      label: 'Buy',
      contexts: COMPANY,
      items: [a(v.commitments, '/commitments', 'commitments'), a(v.subcontractors, '/subcontractors', 'commitments')],
    },
    {
      id: 'bill',
      label: 'Bill',
      contexts: COMPANY,
      items: [a(v.billing, '/billing', 'billing'), a('Retainage', '/retainage', 'retainage'), a(v.draws, '/draws', 'lender_draws')],
    },
    {
      id: 'cost',
      label: 'Cost',
      contexts: COMPANY,
      items: [a('Job cost', '/job-cost', 'budget'), ...(i.booksPresent ? [{ label: 'WIP', href: '/wip' } satisfies NavItem] : [])],
    },
    {
      id: 'controls',
      label: 'Controls',
      contexts: COMPANY,
      items: [
        { label: 'Activity', href: '/activity', keys: 'g a' },
        { label: 'AI decisions', href: '/ai-decisions', disclosure: 'M' },
        { label: 'Settings', href: '/settings', keys: 'g p' },
      ],
    },
    // ---- workspace / consolidated rail ----
    {
      id: 'work',
      label: 'Work',
      contexts: ROLLUP,
      items: [
        { label: v.jobs, href: '/jobs', keys: 'g j', count: c.openJobs || undefined },
        a('Schedule', '/schedule', 'schedule', { keys: 'g s', count: overdue, alert: !!overdue }),
        { label: 'Approvals', href: '/review', keys: 'g r', count: review, processing: true },
      ],
    },
    {
      id: 'insights',
      label: 'Insights',
      contexts: ROLLUP,
      items: [
        { label: 'Margin by job', href: '/insights/margin' },
        { label: 'Backlog', href: '/insights/backlog' },
        ...(i.companyCount > 1 ? [{ label: 'Compare companies', href: '/compare' } satisfies NavItem] : []),
      ],
    },
    {
      id: 'admin',
      contexts: ROLLUP,
      items: [
        { label: 'Activity', href: '/activity', keys: 'g a' },
        { label: 'Onboarding', href: '/onboarding', processing: true },
        { label: 'Settings', href: '/settings', keys: 'g p' },
      ],
    },
  ];
}

/** buildNav + filterNav: what the rail renders. */
export function railNav(i: NavInput): FilteredNavGroup[] {
  const modulesInUse: ReadonlyArray<string> = isDealerNav(i) ? [...i.modules, DEALER_STORE_MODULE] : i.modules;
  return filterNav(buildNav(i), { context: i.context, modulesInUse });
}
