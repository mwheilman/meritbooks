/**
 * The Merit Projects rail (blueprint §4, Wave 0a spec §5). Pure: builds the NavGroup tree for
 * the caller's persona group from the shell context, the company's modules and vocabulary,
 * cheap counts and the caller's access; merit-ui filterNav() then applies context and module
 * activation (A items show only when the company uses the module, or when they hold open work).
 *
 * Each persona gets its own rail. Items the persona can't use are ABSENT (never greyed): an item
 * shows only when it is in the persona's rail AND the caller holds the grant its page needs
 * (canReach, the same rule the page guards use). The rail is UI only — RLS and the page guard
 * are the boundary.
 */
import { filterNav, type FilteredNavGroup, type NavGroup, type NavItem, type ShellContext } from '@meritbooks/merit-ui';
import type { ModuleKey } from '@/lib/packs';
import type { Vocabulary } from '@/lib/pm/vocab';
import { lower } from '@/lib/pm/vocab';
import { isDealerVocab, woVocab } from '@/lib/pm/ops/labels';
import type { Grant, PersonaGroup } from '@/lib/access/types';

export interface NavCounts {
  openJobs?: number;
  toReview?: number;
  overdueTasks?: number;
}

/** The part of Access the rail and the page guards read. `Access` satisfies it. */
export interface NavAccess {
  group: PersonaGroup;
  grants: ReadonlySet<string>;
  byCompany?: Readonly<Record<string, ReadonlySet<string>>>;
}

/**
 * Full grants, management rail. Only for callers with no access in hand (unit tests of the
 * module/vocabulary logic); the app layout always passes the caller's real access.
 */
export const FULL_NAV_ACCESS: NavAccess = { group: 'management', grants: new Set<string>(['*']) };

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
  /** The caller's access (persona group + grants). Omitted only in unit tests: FULL_NAV_ACCESS. */
  access?: NavAccess;
  /** The company in view; grants are read for it (else the union across companies). */
  companyId?: string | null;
}

// ------------------------------------------------------------------ reachability (rail + guards)

/** What a page needs: every `all` grant and at least one `any` grant (when listed). */
interface Rule {
  all?: ReadonlyArray<Grant>;
  any?: ReadonlyArray<Grant>;
}

const APPROVER: ReadonlyArray<Grant> = [
  'projects.change_orders:approve', 'projects.billing:approve', 'projects.commitments:approve',
  'projects.estimates:approve', 'projects.time:approve', 'projects.selections:approve',
];

/** Longest matching prefix wins. Paths not listed need nothing beyond being signed in. */
const RULES: ReadonlyArray<readonly [string, Rule]> = [
  ['/jobs', { all: ['projects.jobs:view'] }],
  ['/review', { any: APPROVER }],
  ['/estimates', { all: ['projects.estimates:view'] }],
  ['/leads', { all: ['projects.leads:view'] }],
  ['/customers', { all: ['projects.customers:view'] }],
  ['/change-orders', { all: ['projects.change_orders:view'] }],
  ['/selections', { all: ['projects.selections:view'] }],
  ['/units', { all: ['projects.jobs:view'] }],
  ['/schedule', { all: ['projects.jobs:view'] }],
  ['/daily-logs', { all: ['projects.jobs:view'] }],
  ['/punch-list', { all: ['projects.jobs:view'] }],
  ['/dispatch', { all: ['projects.dispatch:view'] }],
  ['/work-orders', { all: ['projects.jobs:view'] }],
  ['/agreements', { all: ['projects.customers:view'] }],
  ['/assets', { all: ['projects.jobs:view'] }],
  ['/time', { any: ['projects.time:view', 'projects.time:create'] }],
  ['/production', { all: ['projects.production:view'] }],
  // Commitments are cost; billing is contract-side money (spec §2.1 money tags).
  ['/commitments', { all: ['projects.commitments:view', 'projects.financials:view'] }],
  ['/subcontractors', { all: ['projects.commitments:view', 'projects.financials:view'] }],
  ['/billing', { all: ['projects.billing:view', 'projects.contract_value:view'] }],
  ['/retainage', { all: ['projects.billing:view', 'projects.contract_value:view'] }],
  ['/draws', { all: ['projects.billing:view', 'projects.contract_value:view'] }],
  ['/job-cost', { all: ['projects.financials:view'] }],
  ['/wip', { all: ['projects.financials:view'] }],
  ['/insights', { all: ['projects.reports:view', 'projects.financials:view', 'projects.contract_value:view'] }],
  ['/compare', { all: ['projects.reports:view', 'projects.financials:view', 'projects.contract_value:view'] }],
  ['/activity', { all: ['projects.jobs:view'] }],
  ['/ai-decisions', { all: ['projects.settings:view'] }],
  ['/settings', { all: ['projects.settings:view'] }],
  ['/onboarding', { all: ['projects.settings:configure'] }],
  ['/stock/settings', { all: ['projects.store:view', 'projects.settings:configure'] }],
  ['/stock', { all: ['projects.store:view'] }],
  ['/deals', { all: ['projects.store:view'] }],
  ['/parts', { all: ['projects.store:view'] }],
  ['/rentals', { all: ['projects.store:view'] }],
  ['/warranty', { all: ['projects.store:view'] }],
];

function cleanPath(href: string): string {
  const p = (href.split(/[?#]/)[0] ?? '/').replace(/\/+$/, '');
  return p || '/';
}

function ruleFor(href: string): Rule | null {
  const path = cleanPath(href);
  let best: Rule | null = null;
  let len = -1;
  for (const [prefix, rule] of RULES) {
    if ((path === prefix || path.startsWith(`${prefix}/`)) && prefix.length > len) {
      best = rule;
      len = prefix.length;
    }
  }
  return best;
}

/** The grant check the rail and page guards share: one company's grants, else the union. */
export function holds(access: NavAccess, grant: Grant, companyId?: string | null): boolean {
  const set = companyId && access.byCompany ? access.byCompany[companyId] : access.grants;
  if (!set) return false;
  return set.has('*') || set.has(grant);
}

/** May this caller open this page? Pure; the page guard redirects home when it says no. */
export function canReach(access: NavAccess, href: string, companyId?: string | null): boolean {
  const rule = ruleFor(href);
  if (!rule) return true;
  if (rule.all && !rule.all.every((g) => holds(access, g, companyId))) return false;
  if (rule.any && !rule.any.some((g) => holds(access, g, companyId))) return false;
  return true;
}

// ------------------------------------------------------------------ the rails

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

const COMPANY: ReadonlyArray<ShellContext> = ['client'];
const ROLLUP: ReadonlyArray<ShellContext> = ['workspace', 'consolidated'];

function a(label: string, href: string, module: ModuleKey | typeof DEALER_STORE_MODULE, extra: Partial<NavItem> = {}): NavItem {
  return { label, href, disclosure: 'A', module, ...extra };
}

/** Every destination, named in the company's own words. Rails pick from this. */
function items(i: NavInput) {
  const v = i.vocab;
  const c = i.counts ?? {};
  const review = c.toReview || undefined;
  const overdue = c.overdueTasks || undefined;
  const openJobs = c.openJobs || undefined;
  return {
    home: { label: 'Home', href: '/', keys: 'g h' } satisfies NavItem,
    today: { label: 'Today', href: '/', keys: 'g h' } satisfies NavItem,
    inbox: { label: 'Inbox', href: '/inbox' } satisfies NavItem,
    approvals: { label: 'Approvals', href: '/review', keys: 'g r', count: review, processing: true } satisfies NavItem,
    toReview: { label: 'To review', href: '/review', keys: 'g r', count: review, processing: true } satisfies NavItem,
    me: { label: 'Me', href: '/me', keys: 'g m' } satisfies NavItem,
    jobs: { label: v.jobs, href: '/jobs', keys: 'g j', count: openJobs } satisfies NavItem,
    myJobs: { label: `My ${lower(v.jobs)}`, href: '/jobs', keys: 'g j', count: openJobs } satisfies NavItem,
    // The lead flow and the shared customer list are not pack modules (SHARED-RECORDS §2): they
    // show for everyone holding the grant, in every industry.
    leads: { label: 'Leads', href: '/leads' } satisfies NavItem,
    customers: { label: 'Customers', href: '/customers' } satisfies NavItem,
    estimates: a(v.estimates, '/estimates', 'estimates'),
    changeOrders: a(v.change_orders, '/change-orders', 'change_orders', { keys: 'g c' }),
    selections: a(v.selections, '/selections', 'selections'),
    units: a('Lots and units', '/units', 'lots_units'),
    schedule: a('Schedule', '/schedule', 'schedule', { keys: 'g s', count: overdue, alert: !!overdue }),
    dispatch: a('Dispatch', '/dispatch', 'dispatch'),
    workOrders: a(woVocab(v).many, '/work-orders', 'dispatch'),
    agreements: a('Agreements', '/agreements', 'service_agreements'),
    equipment: a('Equipment', '/assets', 'assets'),
    logs: a(v.daily_logs, '/daily-logs', 'daily_logs'),
    punch: a('Punch list', '/punch-list', 'punch_warranty'),
    time: a('Time', '/time', 'time', { keys: 'g t' }),
    crewTime: a('Crew time', '/time', 'time', { keys: 'g t' }),
    production: a('Production', '/production', 'production'),
    commitments: a(v.commitments, '/commitments', 'commitments'),
    subcontractors: a(v.subcontractors, '/subcontractors', 'commitments'),
    billing: a(v.billing, '/billing', 'billing'),
    retainage: a('Retainage', '/retainage', 'retainage'),
    draws: a(v.draws, '/draws', 'lender_draws'),
    jobCost: a('Job cost', '/job-cost', 'budget'),
    wip: { label: 'WIP', href: '/wip' } satisfies NavItem,
    margin: { label: 'Margin by job', href: '/insights/margin' } satisfies NavItem,
    backlog: { label: 'Backlog', href: '/insights/backlog' } satisfies NavItem,
    compare: { label: 'Compare companies', href: '/compare' } satisfies NavItem,
    activity: { label: 'Activity', href: '/activity', keys: 'g a' } satisfies NavItem,
    aiDecisions: { label: 'AI decisions', href: '/ai-decisions', disclosure: 'M' } satisfies NavItem,
    onboarding: { label: 'Onboarding', href: '/onboarding', processing: true } satisfies NavItem,
    settings: { label: 'Settings', href: '/settings', keys: 'g p' } satisfies NavItem,
    stock: a('Stock', '/stock', DEALER_STORE_MODULE),
    deals: a('Deals', '/deals', DEALER_STORE_MODULE),
    parts: a('Parts', '/parts', DEALER_STORE_MODULE),
    rentals: a('Rentals', '/rentals', DEALER_STORE_MODULE),
    warranty: a('Warranty', '/warranty', DEALER_STORE_MODULE),
  };
}

type Items = ReturnType<typeof items>;

function storeGroup(it: Items): NavGroup {
  return { id: 'store', label: 'Store', contexts: COMPANY, items: [it.stock, it.deals, it.parts, it.rentals, it.warranty] };
}

/** Management (owner, GM): every screen, Pipeline and Insights, Approvals at the top. */
function managementRail(i: NavInput, it: Items): NavGroup[] {
  return [
    { id: 'home', items: [it.home, it.inbox, { ...it.approvals, contexts: COMPANY }] },
    // ---- company rail ----
    storeGroup(it),
    { id: 'sell', label: 'Pipeline', contexts: COMPANY, items: [it.leads, it.customers, it.estimates] },
    { id: 'jobs', label: i.vocab.jobs, contexts: COMPANY, items: [it.jobs, it.changeOrders, it.selections, it.units] },
    {
      id: 'field', label: 'Field', contexts: COMPANY,
      items: [it.schedule, it.dispatch, it.workOrders, it.agreements, it.equipment, it.logs, it.punch, it.time],
    },
    { id: 'make', label: 'Make', contexts: COMPANY, items: [it.production] },
    { id: 'buy', label: 'Buy', contexts: COMPANY, items: [it.commitments, it.subcontractors] },
    { id: 'bill', label: 'Bill', contexts: COMPANY, items: [it.billing, it.retainage, it.draws] },
    { id: 'cost', label: 'Cost', contexts: COMPANY, items: [it.jobCost, ...(i.booksPresent ? [it.wip] : [])] },
    { id: 'insights-co', label: 'Insights', contexts: COMPANY, items: [it.margin, it.backlog] },
    { id: 'controls', label: 'Controls', contexts: COMPANY, items: [it.activity, it.aiDecisions, it.settings] },
    // ---- workspace / consolidated rail ----
    { id: 'work', label: 'Work', contexts: ROLLUP, items: [{ ...it.jobs }, it.schedule, it.approvals] },
    { id: 'pipeline', label: 'Pipeline', contexts: ROLLUP, items: [it.leads, it.customers] },
    {
      id: 'insights', label: 'Insights', contexts: ROLLUP,
      items: [it.margin, it.backlog, ...(i.companyCount > 1 ? [it.compare] : [])],
    },
    { id: 'admin', contexts: ROLLUP, items: [it.activity, it.onboarding, it.settings] },
  ];
}

/** PM: Home, My jobs, Schedule, Changes, Commitments/POs, Billing, Inbox. */
function pmRail(i: NavInput, it: Items): NavGroup[] {
  return [
    { id: 'home', items: [it.home, it.inbox, it.toReview] },
    storeGroup(it),
    { id: 'jobs', label: `My ${lower(i.vocab.jobs)}`, items: [it.myJobs, it.changeOrders, it.selections, it.units, it.jobCost] },
    { id: 'sell', label: 'Customers', items: [it.customers, it.leads] },
    { id: 'field', label: 'Schedule', items: [it.schedule, it.workOrders, it.logs, it.punch, it.time, it.production] },
    { id: 'buy', label: 'Buy', items: [it.commitments, it.subcontractors] },
    { id: 'bill', label: 'Bill', items: [it.billing, it.retainage, it.draws] },
  ];
}

/** Office (office manager, project accountant, dispatcher, purchasing): the needs-you desk. */
function adminRail(i: NavInput, it: Items): NavGroup[] {
  return [
    { id: 'home', items: [it.home, it.inbox, it.toReview] },
    storeGroup(it),
    { id: 'sell', label: 'Calls and leads', items: [it.leads, it.customers, it.estimates] },
    { id: 'jobs', label: i.vocab.jobs, items: [it.jobs, it.changeOrders, it.selections, it.units] },
    { id: 'field', label: 'Schedule and dispatch', items: [it.schedule, it.dispatch, it.workOrders, it.agreements, it.equipment, it.time] },
    { id: 'buy', label: 'Buy', items: [it.commitments, it.subcontractors] },
    { id: 'bill', label: 'Bill', items: [it.billing, it.retainage, it.draws] },
    { id: 'cost', label: 'Cost', items: [it.jobCost, ...(i.booksPresent ? [it.wip] : [])] },
    { id: 'controls', label: 'Controls', items: [it.activity, it.settings] },
  ];
}

/** Supervisor: Today, My jobs, Schedule, Crew time, Logs, Punch. */
function supervisorRail(_i: NavInput, it: Items): NavGroup[] {
  return [
    { id: 'home', items: [it.today, it.myJobs, it.schedule, it.dispatch, it.crewTime, it.logs, it.punch] },
  ];
}

/** Labor: Today, Time, Jobs, Me. Nothing else. */
function laborRail(_i: NavInput, it: Items): NavGroup[] {
  return [{ id: 'home', items: [it.today, it.time, { ...it.jobs, count: undefined }, it.me] }];
}

/** Sales: the pipeline, then the jobs they sold. */
function salesRail(i: NavInput, it: Items): NavGroup[] {
  return [
    { id: 'home', items: [it.home, it.inbox] },
    storeGroup(it),
    { id: 'sell', label: 'Pipeline', items: [it.leads, it.customers, it.estimates] },
    { id: 'jobs', label: `My ${lower(i.vocab.jobs)}`, items: [it.myJobs] },
  ];
}

const RAILS: Readonly<Record<PersonaGroup, (i: NavInput, it: Items) => NavGroup[]>> = {
  management: managementRail,
  pm: pmRail,
  admin: adminRail,
  supervisor: supervisorRail,
  labor: laborRail,
  sales: salesRail,
};

/** The persona's rail, with every item the caller can't reach removed. */
export function buildNav(i: NavInput): NavGroup[] {
  const access = i.access ?? FULL_NAV_ACCESS;
  const it = items(i);
  const reach = (item: NavItem) => canReach(access, item.href, i.companyId);
  return RAILS[access.group](i, it)
    .map((g) => ({ ...g, items: g.items.filter(reach) }))
    .filter((g) => g.items.length > 0);
}

/** buildNav + filterNav: what the rail renders. */
export function railNav(i: NavInput): FilteredNavGroup[] {
  const modulesInUse: ReadonlyArray<string> = isDealerNav(i) ? [...i.modules, DEALER_STORE_MODULE] : i.modules;
  return filterNav(buildNav(i), { context: i.context, modulesInUse });
}
