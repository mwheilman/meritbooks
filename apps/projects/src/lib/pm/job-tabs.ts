/** Job page tabs: the pack's set per job type (manifest v2), else the job type's modules (blueprint §4). Pure. */
import type { ModuleKey } from '@/lib/packs';
import type { JobTab } from './guards';
import type { Vocabulary } from './vocab';
import { woVocab } from '@/lib/pm/ops/labels';
import { MAX_VISIBLE_JOB_TABS, type JobTabKind, type PlanExperience } from '@meritbooks/industry-packs/src/types';
import { jobTabsFor } from '@meritbooks/industry-packs/src/experience';

export interface TabDef {
  value: JobTab;
  label: string;
  /** Arrives in a later wave: honest placeholder, no fake data. */
  later?: boolean;
}

/**
 * Money tabs (estimates, commitments, billing, job cost) are live. Billing carries the
 * retainage release when the job type withholds retainage or uses the retainage module;
 * Job cost needs budgets by cost code.
 */
export function jobTabs(modules: ReadonlySet<ModuleKey>, v: Vocabulary): TabDef[] {
  const t: TabDef[] = [{ value: 'overview', label: 'Overview' }];
  if (modules.has('estimates')) t.push({ value: 'estimates', label: v.estimate });
  if (modules.has('budget')) t.push({ value: 'budget', label: 'Budget' });
  if (modules.has('schedule')) t.push({ value: 'schedule', label: 'Schedule' });
  if (modules.has('change_orders')) t.push({ value: 'change-orders', label: v.change_orders });
  t.push({ value: 'contract', label: 'Contract' });
  if (modules.has('commitments')) t.push({ value: 'commitments', label: v.commitments });
  if (modules.has('billing') || modules.has('retainage')) t.push({ value: 'billing', label: v.billing });
  if (modules.has('budget')) t.push({ value: 'job-cost', label: 'Job cost' });
  if (modules.has('dispatch')) t.push({ value: 'work-orders', label: woVocab(v).many });
  if (modules.has('production')) t.push({ value: 'production', label: 'Production' });
  if (modules.has('selections') || modules.has('procurement_markup')) t.push({ value: 'selections', label: v.selections });
  if (modules.has('lender_draws')) t.push({ value: 'draws', label: v.draws });
  if (modules.has('lots_units')) t.push({ value: 'units', label: 'Lots and units' });
  if (modules.has('daily_logs')) t.push({ value: 'logs', label: v.daily_logs });
  if (modules.has('punch_warranty')) t.push({ value: 'punch', label: 'Punch list' });
  if (modules.has('time')) t.push({ value: 'time', label: 'Time' });
  if (modules.has('documents')) t.push({ value: 'documents', label: 'Documents' });
  t.push({ value: 'activity', label: 'Activity' });
  return t;
}

export function pickTab(tabs: ReadonlyArray<TabDef>, requested: string | undefined): TabDef {
  return tabs.find((t) => t.value === requested) ?? tabs[0]!;
}

// ---------------------------------------------------------------------------
// Pack manifest v2: tabs per job type (UX seat §3d — the pack's set, ≤7 visible plus More)
// ---------------------------------------------------------------------------


/** Tabs that are screens on the job page, plus the honest placeholders a pack may name. */
export type JobTabValue =
  | JobTab | 'team' | 'rfis' | 'client-view' | 'equipment' | 'agreement' | 'parts' | 'warranty-claim'
  | 'capital-stack' | 'bom' | 'tm-tickets' | 'receiving' | 'productivity';

export interface JobTabDef {
  value: JobTabValue;
  label: string;
  /** Not built yet: an honest placeholder that links to where the work lives. */
  later?: boolean;
}

interface KindSpec {
  value: JobTabValue;
  /** Shown only when the job type uses one of these modules (none listed = always). */
  modules?: ReadonlyArray<ModuleKey>;
  label: (v: Vocabulary) => string;
  later?: true;
}

export const TAB_KINDS: Readonly<Record<JobTabKind, KindSpec>> = {
  overview: { value: 'overview', label: () => 'Overview' },
  estimates: { value: 'estimates', modules: ['estimates'], label: (v) => v.estimate },
  budget: { value: 'budget', modules: ['budget'], label: () => 'Budget' },
  schedule: { value: 'schedule', modules: ['schedule'], label: () => 'Schedule' },
  change_orders: { value: 'change-orders', modules: ['change_orders'], label: (v) => v.change_orders },
  contract: { value: 'contract', label: () => 'Contract' },
  commitments: { value: 'commitments', modules: ['commitments'], label: (v) => v.commitments },
  billing: { value: 'billing', modules: ['billing', 'retainage'], label: (v) => v.billing },
  job_cost: { value: 'job-cost', modules: ['budget'], label: () => 'Job cost' },
  work_orders: { value: 'work-orders', modules: ['dispatch'], label: (v) => woVocab(v).many },
  production: { value: 'production', modules: ['production'], label: () => 'Production' },
  selections: { value: 'selections', modules: ['selections', 'procurement_markup'], label: (v) => v.selections },
  draws: { value: 'draws', modules: ['lender_draws'], label: (v) => v.draws },
  units: { value: 'units', modules: ['lots_units'], label: () => 'Lots and units' },
  logs: { value: 'logs', modules: ['daily_logs'], label: (v) => v.daily_logs },
  punch: { value: 'punch', modules: ['punch_warranty'], label: () => 'Punch list' },
  time: { value: 'time', modules: ['time'], label: () => 'Time' },
  documents: { value: 'documents', label: () => 'Documents' },
  activity: { value: 'activity', label: () => 'Activity' },
  team: { value: 'team', label: () => 'People' },
  rfis: { value: 'rfis', modules: ['rfis_submittals'], label: () => 'RFIs & submittals', later: true },
  client_view: { value: 'client-view', modules: ['client_approvals'], label: () => 'Client view', later: true },
  equipment: { value: 'equipment', label: () => 'Equipment', later: true },
  agreement: { value: 'agreement', label: () => 'Agreement', later: true },
  parts: { value: 'parts', label: () => 'Parts', later: true },
  warranty_claim: { value: 'warranty-claim', label: () => 'Warranty claim', later: true },
  capital_stack: { value: 'capital-stack', modules: ['lender_draws'], label: () => 'Capital stack', later: true },
  bom: { value: 'bom', modules: ['production'], label: () => 'BOM & cut list', later: true },
  tm_tickets: { value: 'tm-tickets', label: () => 'T&M tickets', later: true },
  receiving: { value: 'receiving', modules: ['commitments', 'procurement_markup'], label: () => 'Receiving', later: true },
  productivity: { value: 'productivity', modules: ['budget', 'time'], label: () => 'Production', later: true },
};

const ALL_VALUES: ReadonlySet<string> = new Set(Object.values(TAB_KINDS).map((k) => k.value));

export function isJobTabValue(v: string | undefined | null): v is JobTabValue {
  return !!v && ALL_VALUES.has(v);
}

export interface ResolvedJobTabs {
  /** The tab row (≤ MAX_VISIBLE_JOB_TABS). */
  visible: JobTabDef[];
  /** Behind "More": the rest of the pack's tabs, module tabs the pack did not order, and placeholders. */
  more: JobTabDef[];
  /** The tab the job opens on when the URL names none. */
  defaultTab: JobTabValue;
  source: 'pack' | 'modules';
}

export interface ResolveTabsInput {
  experience: PlanExperience | null | undefined;
  jobTypeKey: string;
  modules: ReadonlySet<ModuleKey>;
  vocab: Vocabulary;
  /** Grant and money filter (absent, not greyed). Overview and Activity always pass. */
  allow?: (tab: JobTabValue) => boolean;
}

function usable(spec: KindSpec, modules: ReadonlySet<ModuleKey>): boolean {
  return !spec.modules || spec.modules.some((m) => modules.has(m));
}

/**
 * Tabs for one job: the pack's set for its job type in pack order and words (manifest v2), then
 * every module tab the pack did not order (so nothing a job type uses becomes unreachable), then
 * Activity. Placeholders never take a slot in the row; they wait behind More. Without a pack set
 * (a v1 install, an unknown pack) the module-driven order of jobTabs() applies.
 */
export function resolveJobTabs(i: ResolveTabsInput): ResolvedJobTabs {
  const allow = (v: JobTabValue) => v === 'overview' || v === 'activity' || (i.allow ? i.allow(v) : true);
  const set = jobTabsFor(i.experience, i.jobTypeKey);
  const ordered: JobTabDef[] = [];
  const seen = new Set<JobTabValue>();
  const push = (d: JobTabDef) => {
    if (seen.has(d.value) || !allow(d.value)) return;
    seen.add(d.value);
    ordered.push(d);
  };
  if (set) {
    for (const t of set.tabs) {
      const spec = TAB_KINDS[t.tab];
      if (!spec || !usable(spec, i.modules)) continue;
      push({ value: spec.value, label: t.label ?? spec.label(i.vocab), ...(spec.later ? { later: true } : {}) });
    }
  }
  for (const d of jobTabs(i.modules, i.vocab)) push({ value: d.value, label: d.label, ...(d.later ? { later: true } : {}) });
  push({ value: 'team', label: 'People' });
  push({ value: 'activity', label: 'Activity' });

  const live = ordered.filter((t) => !t.later);
  const visible = live.slice(0, MAX_VISIBLE_JOB_TABS);
  const more = [...live.slice(MAX_VISIBLE_JOB_TABS), ...ordered.filter((t) => t.later)];
  const wanted = set ? TAB_KINDS[set.default_tab]?.value : undefined;
  const defaultTab = wanted && visible.some((t) => t.value === wanted) ? wanted : visible[0]!.value;
  return { visible, more, defaultTab, source: set ? 'pack' : 'modules' };
}

/** The tab to render: the URL's when it is one of this job's tabs, else the default. */
export function pickJobTab(r: ResolvedJobTabs, requested: string | undefined): JobTabDef {
  const all = [...r.visible, ...r.more];
  return all.find((t) => t.value === requested) ?? all.find((t) => t.value === r.defaultTab)!;
}
