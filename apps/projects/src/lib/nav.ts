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
import type { NavItemKey, PlanExperience } from '@meritbooks/industry-packs/src/types';
import { navFor } from '@meritbooks/industry-packs/src/experience';

export interface NavCounts {
  openJobs?: number;
  toReview?: number;
  overdueTasks?: number;
  /** Approvals waiting on the caller (GET /api/approvals?mine → counts.mine). */
  approvalsMine?: number;
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
  /**
   * The company's industry experience (pack manifest v2). When it names a rail for the caller's
   * persona group, that rail leads (pack order and labels) and the rest of the persona's
   * destinations fold behind "More". Company context only: roll-up views keep the built-in rails.
   */
  experience?: PlanExperience | null;
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
  // Approvals: every member (preparers see "Waiting on others"); the rules page is Settings.
  ['/approvals/policies', { all: ['projects.settings:view'] }],
  ['/documents', { all: ['projects.documents:view'] }],
  ['/inbox/company', { all: ['projects.settings:configure'] }],
  // Field service depth (1117)
  ['/calls/campaigns', { any: ['projects.reports:view', 'projects.leads:view'] }],
  ['/calls', { all: ['projects.dispatch:edit'] }],
  ['/pricebook', { any: ['projects.settings:view', 'projects.dispatch:view', 'projects.estimates:view'] }],
  ['/dispatch/capacity', { all: ['projects.dispatch:view'] }],
  ['/dispatch/scorecards', { all: ['projects.jobs:view'] }],
  ['/dispatch/visit', { all: ['projects.jobs:view'] }],
  // Wave B: portals (1118), residential (1119), commercial (1120), imports (1121), industry depth (1122)
  ['/portal-access', { any: ['projects.customers:view', 'projects.commitments:view', 'projects.billing:view'] }],
  ['/proposals', { all: ['projects.estimates:view'] }],
  ['/homes', { all: ['projects.jobs:view'] }],
  ['/communities', { all: ['projects.jobs:view'] }],
  ['/change-events', { all: ['projects.change_orders:view'] }],
  ['/rfis', { all: ['projects.jobs:view'] }],
  ['/submittals', { all: ['projects.jobs:view'] }],
  ['/meetings', { all: ['projects.jobs:view'] }],
  ['/compliance', { all: ['projects.commitments:view', 'projects.financials:view'] }],
  ['/setup/imports', { all: ['projects.settings:configure'] }],
  ['/flooring/pay', { all: ['projects.time:view'] }],
  ['/flooring', { all: ['projects.jobs:view'] }],
  ['/design', { all: ['projects.selections:view'] }],
  ['/development', { all: ['projects.financials:view'] }],
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

/**
 * Industry screens that are not pack modules follow the company's pack (Wave B depth): the key a
 * rail item names as its module is switched on when a company in view runs one of these packs.
 */
export const PACK_SCREENS: Readonly<Record<string, ReadonlyArray<string>>> = {
  'pack:residential': ['residential_remodel', 'home_builder'],
  'pack:homes': ['home_builder', 'real_estate_development'],
  'pack:commercial': ['commercial_gc', 'specialty_trade'],
  'pack:flooring': ['flooring'],
  'pack:design': ['interior_design'],
  'pack:development': ['real_estate_development'],
};

export function packScreensInUse(packKeys: ReadonlyArray<string> | undefined): string[] {
  const keys = new Set(packKeys ?? []);
  return Object.entries(PACK_SCREENS).filter(([, packs]) => packs.some((p) => keys.has(p))).map(([m]) => m);
}

export function isDealerNav(i: Pick<NavInput, 'vocab' | 'packKeys' | 'archetypes'>): boolean {
  return (i.packKeys ?? []).includes('equipment_dealer') || (i.archetypes ?? []).includes('dealer_service') || isDealerVocab(i.vocab);
}

const COMPANY: ReadonlyArray<ShellContext> = ['client'];
const ROLLUP: ReadonlyArray<ShellContext> = ['workspace', 'consolidated'];

function a(label: string, href: string, module: ModuleKey | typeof DEALER_STORE_MODULE | keyof typeof PACK_SCREENS, extra: Partial<NavItem> = {}): NavItem {
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
    // Approvals is the unified approvals inbox (Wave A); To review is the change-order review queue.
    approvals: { label: 'Approvals', href: '/approvals', keys: 'g r', count: c.approvalsMine || undefined, processing: true } satisfies NavItem,
    outOfOffice: { label: 'Out of office', href: '/approvals/delegation', disclosure: 'M' } satisfies NavItem,
    approvalRules: { label: 'Approval rules', href: '/approvals/policies', disclosure: 'M' } satisfies NavItem,
    companyMessages: { label: 'Company messages', href: '/inbox/company', disclosure: 'M' } satisfies NavItem,
    calls: a('Calls', '/calls', 'dispatch'),
    campaigns: a('Campaigns', '/calls/campaigns', 'dispatch'),
    priceBook: a('Price book', '/pricebook', 'dispatch'),
    capacity: a('Capacity', '/dispatch/capacity', 'dispatch'),
    scorecards: a('Scorecards', '/dispatch/scorecards', 'dispatch'),
    // ---- Wave B
    portals: { label: 'Portals', href: '/portal-access' } satisfies NavItem,
    proposals: a('Proposals', '/proposals', 'pack:residential'),
    homes: a('Homes', '/homes', 'pack:homes'),
    communities: a('Communities', '/communities', 'pack:homes'),
    changeEvents: a('Change events', '/change-events', 'pack:commercial'),
    rfis: a('RFIs', '/rfis', 'rfis_submittals'),
    submittals: a('Submittals', '/submittals', 'rfis_submittals'),
    meetings: a('Meetings', '/meetings', 'pack:commercial'),
    compliance: a('Compliance', '/compliance', 'compliance'),
    imports: { label: 'Imports', href: '/setup/imports', disclosure: 'M' } satisfies NavItem,
    flooring: a('Flooring', '/flooring', 'pack:flooring'),
    flooringPay: a('Installer pay', '/flooring/pay', 'pack:flooring'),
    flooringRolls: a('Rolls and remnants', '/flooring/rolls', 'pack:flooring'),
    flooringCatalog: a('Catalog', '/flooring/catalog', 'pack:flooring'),
    design: a('Design procurement', '/design', 'pack:design'),
    designInbox: a('Vendor inbox', '/design/inbox', 'pack:design'),
    development: a('Development', '/development', 'pack:development'),
    partsCounter: a('Parts counter', '/parts/counter', DEALER_STORE_MODULE),
    priceFiles: a('Price files', '/parts/price-files', DEALER_STORE_MODULE),
    storeScorecard: a('Scorecard', '/stock/kpis', DEALER_STORE_MODULE),
    programs: a('Programs', '/stock/programs', DEALER_STORE_MODULE),
    warrantyDeadlines: a('Warranty deadlines', '/warranty?band=DRAFT', DEALER_STORE_MODULE),
    warrantyCredits: a('Warranty credits', '/warranty/credits', DEALER_STORE_MODULE),
    techBoard: a('Tech board', '/work-orders/tech-board', DEALER_STORE_MODULE),
    station: a('Station', '/production/kiosk', 'production'),
    shopBacklog: a('Shop backlog', '/production/backlog', 'production'),
    cadImports: a('CAD imports', '/production/cad', 'production'),
    materials: a('Material', '/production/materials', 'production'),
    remakes: a('Remakes', '/production/remakes', 'production'),
    installs: a('Installs', '/production/installs', 'production'),
    toReview: { label: 'To review', href: '/review', keys: 'g v', count: review, processing: true } satisfies NavItem,
    documents: { label: 'Documents', href: '/documents', keys: 'g d' } satisfies NavItem,
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
  return {
    id: 'store', label: 'Store', contexts: COMPANY,
    items: [it.stock, it.deals, it.parts, it.partsCounter, it.rentals, it.warranty, it.techBoard, it.warrantyDeadlines, it.warrantyCredits, it.priceFiles, it.programs, it.storeScorecard],
  };
}

/** Management (owner, GM): every screen, Pipeline and Insights, Approvals at the top. */
function managementRail(i: NavInput, it: Items): NavGroup[] {
  return [
    { id: 'home', items: [it.home, it.inbox, { ...it.approvals, contexts: COMPANY }, { ...it.toReview, contexts: COMPANY }] },
    // ---- company rail ----
    storeGroup(it),
    { id: 'sell', label: 'Pipeline', contexts: COMPANY, items: [it.leads, it.customers, it.estimates, it.proposals] },
    { id: 'jobs', label: i.vocab.jobs, contexts: COMPANY, items: [it.jobs, it.homes, it.communities, it.flooring, it.design, it.development, it.changeOrders, it.changeEvents, it.rfis, it.submittals, it.meetings, it.selections, it.units] },
    {
      id: 'field', label: 'Field', contexts: COMPANY,
      items: [it.schedule, it.calls, it.dispatch, it.capacity, it.workOrders, it.agreements, it.equipment, it.priceBook, it.logs, it.punch, it.time, it.scorecards, it.campaigns],
    },
    { id: 'make', label: 'Make', contexts: COMPANY, items: [it.production, it.station, it.shopBacklog, it.cadImports, it.materials, it.remakes, it.installs] },
    { id: 'buy', label: 'Buy', contexts: COMPANY, items: [it.commitments, it.subcontractors, it.compliance, it.designInbox, it.flooringRolls, it.flooringCatalog] },
    { id: 'bill', label: 'Bill', contexts: COMPANY, items: [it.billing, it.retainage, it.draws, it.flooringPay] },
    { id: 'cost', label: 'Cost', contexts: COMPANY, items: [it.jobCost, it.wip] },
    { id: 'insights-co', label: 'Insights', contexts: COMPANY, items: [it.margin, it.backlog] },
    { id: 'controls', label: 'Controls', contexts: COMPANY, items: [it.documents, it.portals, it.activity, it.aiDecisions, it.settings, it.imports, it.approvalRules, it.outOfOffice, it.companyMessages] },
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
    { id: 'home', items: [it.home, it.inbox, it.approvals, it.toReview] },
    storeGroup(it),
    { id: 'jobs', label: `My ${lower(i.vocab.jobs)}`, items: [it.myJobs, it.homes, it.flooring, it.design, it.development, it.changeOrders, it.changeEvents, it.rfis, it.submittals, it.meetings, it.selections, it.units, it.jobCost, it.wip] },
    { id: 'sell', label: 'Customers', items: [it.customers, it.leads, it.proposals, it.communities] },
    { id: 'field', label: 'Schedule', items: [it.schedule, it.dispatch, it.capacity, it.workOrders, it.logs, it.punch, it.time, it.production, it.shopBacklog, it.cadImports, it.materials, it.remakes, it.installs, it.priceBook, it.scorecards] },
    { id: 'away', items: [it.outOfOffice] },
    { id: 'buy', label: 'Buy', items: [it.commitments, it.subcontractors, it.compliance, it.designInbox, it.flooringRolls] },
    { id: 'bill', label: 'Bill', items: [it.billing, it.retainage, it.draws, it.flooringPay] },
  ];
}

/** Office (office manager, project accountant, dispatcher, purchasing): the needs-you desk. */
function adminRail(i: NavInput, it: Items): NavGroup[] {
  return [
    { id: 'home', items: [it.home, it.inbox, it.approvals, it.toReview] },
    storeGroup(it),
    { id: 'sell', label: 'Calls and leads', items: [it.leads, it.customers, it.estimates, it.proposals] },
    { id: 'jobs', label: i.vocab.jobs, items: [it.jobs, it.homes, it.communities, it.flooring, it.design, it.development, it.changeOrders, it.changeEvents, it.rfis, it.submittals, it.meetings, it.selections, it.units] },
    { id: 'field', label: 'Schedule and dispatch', items: [it.schedule, it.calls, it.dispatch, it.capacity, it.workOrders, it.agreements, it.equipment, it.priceBook, it.time, it.campaigns] },
    { id: 'buy', label: 'Buy', items: [it.commitments, it.subcontractors, it.compliance, it.designInbox, it.flooringRolls, it.flooringCatalog] },
    { id: 'bill', label: 'Bill', items: [it.billing, it.retainage, it.draws, it.flooringPay] },
    { id: 'cost', label: 'Cost', items: [it.jobCost, it.wip] },
    { id: 'make', label: 'Make', items: [it.production, it.shopBacklog, it.cadImports, it.materials, it.remakes, it.installs] },
    { id: 'controls', label: 'Controls', items: [it.documents, it.portals, it.activity, it.settings, it.imports, it.approvalRules, it.outOfOffice, it.companyMessages] },
  ];
}

/** Supervisor: Today, My jobs, Schedule, Crew time, Logs, Punch. */
function supervisorRail(_i: NavInput, it: Items): NavGroup[] {
  return [
    { id: 'home', items: [it.today, it.myJobs, it.schedule, it.dispatch, it.crewTime, it.logs, it.punch, { ...it.documents, label: 'Docs' }, it.approvals, it.scorecards] },
  ];
}

/** Labor: Today, Time, Jobs, Me. Nothing else. */
function laborRail(_i: NavInput, it: Items): NavGroup[] {
  return [{ id: 'home', items: [it.today, it.time, { ...it.jobs, count: undefined }, it.me] }];
}

/** Sales: the pipeline, then the jobs they sold. */
function salesRail(i: NavInput, it: Items): NavGroup[] {
  return [
    { id: 'home', items: [it.home, it.inbox, it.approvals] },
    storeGroup(it),
    { id: 'sell', label: 'Pipeline', items: [it.leads, it.customers, it.estimates, it.priceBook, it.campaigns] },
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

/** Manifest rail item key → the destination it names. */
const NAV_ITEM_DEST: Readonly<Record<NavItemKey, keyof Items>> = {
  home: 'home', today: 'today', inbox: 'inbox', approvals: 'approvals', to_review: 'toReview', me: 'me', jobs: 'jobs',
  my_jobs: 'myJobs', leads: 'leads', customers: 'customers', estimates: 'estimates', change_orders: 'changeOrders',
  selections: 'selections', units: 'units', schedule: 'schedule', dispatch: 'dispatch', work_orders: 'workOrders',
  agreements: 'agreements', equipment: 'equipment', logs: 'logs', punch: 'punch', time: 'time', crew_time: 'crewTime',
  production: 'production', commitments: 'commitments', subcontractors: 'subcontractors', billing: 'billing',
  retainage: 'retainage', draws: 'draws', job_cost: 'jobCost', wip: 'wip', margin: 'margin', backlog: 'backlog',
  compare: 'compare', activity: 'activity', ai_decisions: 'aiDecisions', onboarding: 'onboarding', settings: 'settings',
  documents: 'documents', stock: 'stock', deals: 'deals', parts: 'parts', rentals: 'rentals', warranty: 'warranty',
  calls: 'calls', campaigns: 'campaigns', price_book: 'priceBook', capacity: 'capacity', scorecards: 'scorecards',
  out_of_office: 'outOfOffice', approval_rules: 'approvalRules', company_messages: 'companyMessages',
  portals: 'portals', proposals: 'proposals', homes: 'homes', communities: 'communities', change_events: 'changeEvents',
  rfis: 'rfis', submittals: 'submittals', meetings: 'meetings', compliance: 'compliance', imports: 'imports',
  flooring: 'flooring', flooring_pay: 'flooringPay', flooring_rolls: 'flooringRolls', flooring_catalog: 'flooringCatalog',
  design: 'design', design_inbox: 'designInbox', development: 'development', parts_counter: 'partsCounter',
  price_files: 'priceFiles', store_scorecard: 'storeScorecard', programs: 'programs', warranty_deadlines: 'warrantyDeadlines',
  warranty_credits: 'warrantyCredits', tech_board: 'techBoard', station: 'station', shop_backlog: 'shopBacklog',
  cad_imports: 'cadImports', materials: 'materials', remakes: 'remakes', installs: 'installs',
};

export function navDestination(key: NavItemKey, i: NavInput): NavItem {
  return items(i)[NAV_ITEM_DEST[key]];
}

function modulesInUse(i: NavInput): ReadonlyArray<string> {
  return [...i.modules, ...(isDealerNav(i) ? [DEALER_STORE_MODULE] : []), ...packScreensInUse(i.packKeys)];
}

/** filterNav's activation rule (A items show when their module is in use or they hold open work). */
function activated(item: NavItem, used: ReadonlyArray<string>): boolean {
  if (item.disclosure !== 'A') return true;
  const open = typeof item.count === 'number' ? item.count > 0 : typeof item.count === 'string' && item.count.length > 0;
  return (item.module !== undefined && used.includes(item.module)) || open;
}

/**
 * The pack's rail for this persona (company context): the pack's items in its order and words,
 * then a folded "More" group with the persona's other destinations (module-activated, deduped by
 * page, chords dropped so the pack rail owns them).
 */
function packRail(i: NavInput, it: Items, access: NavAccess): NavGroup[] | null {
  if (i.context !== 'client') return null;
  const entries = navFor(i.experience, access.group);
  if (!entries) return null;
  const lead: NavItem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const dest = it[NAV_ITEM_DEST[e.item]];
    if (!dest || seen.has(dest.href)) continue;
    seen.add(dest.href);
    lead.push(e.label ? { ...dest, id: `pack:${e.item}`, label: e.label } : { ...dest, id: `pack:${e.item}` });
  }
  const used = modulesInUse(i);
  const rest: NavItem[] = [];
  for (const g of RAILS[access.group](i, it)) {
    if (g.contexts && !g.contexts.includes('client')) continue;
    for (const item of g.items) {
      if (item.contexts && !item.contexts.includes('client')) continue;
      if (seen.has(item.href) || !activated(item, used)) continue;
      seen.add(item.href);
      const { keys: _k, ...noChord } = item;
      rest.push({ ...noChord, disclosure: 'M' });
    }
  }
  return [
    { id: 'pack', items: lead },
    ...(rest.length ? [{ id: 'more', items: rest }] : []),
  ];
}

/** The persona's rail, with every item the caller can't reach removed. */
export function buildNav(i: NavInput): NavGroup[] {
  const access = i.access ?? FULL_NAV_ACCESS;
  const it = items(i);
  const reach = (item: NavItem) => canReach(access, item.href, i.companyId);
  return (packRail(i, it, access) ?? RAILS[access.group](i, it))
    .map((g) => ({ ...g, items: g.items.filter(reach) }))
    .filter((g) => g.items.length > 0);
}

/** buildNav + filterNav: what the rail renders. */
export function railNav(i: NavInput): FilteredNavGroup[] {
  return filterNav(buildNav(i), { context: i.context, modulesInUse: modulesInUse(i) });
}
