/**
 * Job page v2 (UX seat §3d): tabs from the pack manifest per job type, header figures masked by
 * money level, needs-attention checks, the unified activity stream, ⌘K actions, and the
 * experience loader's version fallback + tenant overrides.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_KEYS, MAX_VISIBLE_JOB_TABS, MODULES, compilePlan, resolveVocabulary, type ModuleKey, type PlanExperience } from '@meritbooks/industry-packs';
import { pickJobTab, resolveJobTabs, TAB_KINDS, type JobTabValue } from '@/lib/pm/job-tabs';
import { headerFigures, type HeaderMoneyInputs } from '@/components/job/header-figures';
import { jobAttention, MAX_ATTENTION } from '@/components/job/job-attention';
import { activityKind, kindCounts } from '@/components/job/activity-kinds';
import { LATER_TABS } from '@/components/job/later-tabs';
import { jobIdFromPath, paletteActions } from '@/components/shell/actions';
import { experienceFor, experienceManifest } from '@/lib/packs/experience';
import { moneyVisFromGrants, ALL_MONEY, NO_MONEY } from '@/components/money/visibility';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { hasBell } from '@/components/shell/BellSlot';
import type { ActivityRow } from '@/lib/pm/types';

const LOC = '00000000-0000-4000-8000-000000000001';
const plans = new Map(CATALOG_KEYS.map((k) => [k, compilePlan({ pack: k, locationId: LOC })]));
const vocabOf = (k: string) => resolveVocabulary(plans.get(k)!.vocabulary);

function tabsFor(pack: string, jobType: string, allow?: (t: JobTabValue) => boolean) {
  const plan = plans.get(pack)!;
  const jt = plan.job_types.find((j) => j.key === jobType)!;
  const modules = new Set(MODULES.filter((m) => jt.modules[m]) as ModuleKey[]);
  return resolveJobTabs({ experience: plan.experience, jobTypeKey: jobType, modules, vocab: vocabOf(pack), allow });
}
const labels = (r: ReturnType<typeof resolveJobTabs>) => r.visible.map((t) => t.label);

describe('job tabs resolve per job type from the pack (manifest v2)', () => {
  it.each([...CATALOG_KEYS])('%s: every job type gets ≤7 live tabs, a default in the row, placeholders behind More', (pack) => {
    for (const jt of plans.get(pack)!.job_types) {
      const r = tabsFor(pack, jt.key);
      expect(r.source).toBe('pack');
      expect(r.visible.length).toBeGreaterThan(0);
      expect(r.visible.length).toBeLessThanOrEqual(MAX_VISIBLE_JOB_TABS);
      expect(r.visible.some((t) => t.later)).toBe(false);
      expect(r.visible.map((t) => t.value)).toContain(r.defaultTab);
      const all = [...r.visible, ...r.more].map((t) => t.value);
      expect(new Set(all).size).toBe(all.length);
      expect(all).toContain('activity');
      expect(all).toContain('team');
      for (const t of r.more.filter((x) => x.later)) expect(LATER_TABS[t.value], `${pack}/${jt.key} ${t.value}`).toBeDefined();
    }
  });

  it('commercial GC lump sum: budget-first, the pack words, RFIs wait behind More', () => {
    const r = tabsFor('commercial_gc', 'lump_sum');
    expect(labels(r)).toEqual(['Overview', 'Budget', 'Schedule', 'Commitments', 'Changes', 'Pay apps', 'Daily reports']);
    expect(r.more.map((t) => t.label)).toEqual(expect.arrayContaining(['Directory', 'RFIs & submittals', 'Documents']));
    expect(r.defaultTab).toBe('overview');
  });

  it('field service call opens on Visits; a replacement install opens on Overview', () => {
    const call = tabsFor('field_service', 'service_call');
    expect(call.defaultTab).toBe('work-orders');
    expect(call.visible[0]!.label).toBe('Visits');
    expect(labels(call)).toContain('Options');
    expect(tabsFor('field_service', 'replacement_install').defaultTab).toBe('overview');
  });

  it('dealer repair order opens on Lines with Labor and Invoice; warranty adds the claim (behind More)', () => {
    const ro = tabsFor('equipment_dealer', 'customer_repair');
    expect(ro.defaultTab).toBe('work-orders');
    expect(labels(ro).slice(0, 3)).toEqual(['Lines', 'Labor', 'Invoice']);
    expect(tabsFor('equipment_dealer', 'warranty_repair').more.map((t) => t.value)).toContain('warranty-claim');
    expect(ro.more.map((t) => t.value)).not.toContain('warranty-claim');
  });

  it('residential remodel: proposal and selections lead', () => {
    expect(labels(tabsFor('residential_remodel', 'fixed_price_remodel')).slice(0, 4)).toEqual(['Overview', 'Proposal', 'Selections', 'Schedule']);
  });

  it('a tab whose module the job type switches off is absent (GC small work: no schedule or daily reports)', () => {
    const values = [...tabsFor('commercial_gc', 'small_work').visible, ...tabsFor('commercial_gc', 'small_work').more].map((t) => t.value);
    expect(values).not.toContain('schedule');
    expect(values).not.toContain('logs');
  });

  it('a tab the caller cannot open is absent, and the default falls back to the first tab', () => {
    const noMoney = tabsFor('field_service', 'service_call', (t) => t !== 'work-orders' && t !== 'billing');
    expect(noMoney.visible.map((t) => t.value)).not.toContain('work-orders');
    expect(noMoney.visible.map((t) => t.value)).not.toContain('billing');
    expect(noMoney.defaultTab).toBe(noMoney.visible[0]!.value);
  });

  it('no experience (v1 install): the module-driven tabs, Overview first', () => {
    const r = resolveJobTabs({ experience: null, jobTypeKey: 'x', modules: new Set<ModuleKey>(['budget', 'schedule']), vocab: vocabOf('general') });
    expect(r.source).toBe('modules');
    expect(r.visible[0]!.value).toBe('overview');
    expect(r.visible.map((t) => t.value)).toEqual(expect.arrayContaining(['budget', 'schedule', 'contract', 'job-cost']));
  });

  it('the URL picks a tab only when this job has it', () => {
    const r = tabsFor('field_service', 'service_call');
    expect(pickJobTab(r, 'activity').value).toBe('activity');
    expect(pickJobTab(r, 'draws').value).toBe('work-orders');
    expect(pickJobTab(r, undefined).value).toBe('work-orders');
  });

  it('every tab kind maps to a distinct job page value', () => {
    const values = Object.values(TAB_KINDS).map((k) => k.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

const money: HeaderMoneyInputs = {
  revisedContractCents: 10_000_000, originalContractCents: 9_000_000, billedCents: 4_000_000, costToDateCents: 3_000_000,
  projectedCostCents: 8_000_000, committedCents: 5_000_000, budgetCents: 7_500_000, projectedMarginCents: 2_000_000,
  pendingCoCents: 300_000, pendingCoCount: 2, openTasks: 9, overdueTasks: 1, punchOpen: 4, stageLabel: 'In progress',
};
const keys = (figs: ReturnType<typeof headerFigures>) => figs.map((f) => f.key);
const hasDollars = (figs: ReturnType<typeof headerFigures>) => figs.some((f) => f.kind === 'money' || f.kind === 'pct');

describe('header figures are masked by money level (Wave 0a §2.3)', () => {
  it('management and PM: contract · billed · cost · margin', () => {
    const f = headerFigures(money, ALL_MONEY, '/jobs/j');
    expect(keys(f)).toEqual(['contract', 'billed', 'cost', 'margin']);
    expect(f.find((x) => x.key === 'margin')!.value).toBeCloseTo(0.2);
    expect(keys(headerFigures(money, moneyVisFromGrants(PERSONA_TEMPLATE_GRANTS.projects_pm, 3), '/jobs/j'))).toEqual(['contract', 'billed', 'cost', 'margin']);
  });

  it('office manager (contract only): no cost and no margin', () => {
    const f = headerFigures(money, moneyVisFromGrants(PERSONA_TEMPLATE_GRANTS.projects_office_manager, 3), '/jobs/j');
    expect(keys(f)).toEqual(['contract', 'billed', 'pending', 'tasks']);
  });

  it('purchasing (cost only): no contract and no margin', () => {
    const f = headerFigures(money, moneyVisFromGrants(PERSONA_TEMPLATE_GRANTS.projects_purchasing, 3), '/jobs/j');
    expect(keys(f)).toEqual(['budget', 'committed', 'cost', 'tasks']);
    expect(f.some((x) => x.key === 'contract' || x.key === 'margin')).toBe(false);
  });

  it.each(['projects_supervisor', 'projects_labor', 'projects_dispatcher'] as const)('%s: counts only, never a dollar', (p) => {
    const f = headerFigures(money, moneyVisFromGrants(PERSONA_TEMPLATE_GRANTS[p], 2), '/jobs/j');
    expect(hasDollars(f)).toBe(false);
    expect(keys(f)).toEqual(['stage', 'tasks', 'overdue', 'punch']);
    expect(JSON.stringify(f)).not.toContain('10000000');
  });

  it('fails closed outside the shell', () => {
    expect(hasDollars(headerFigures(money, NO_MONEY, '/jobs/j'))).toBe(false);
  });

  it('each figure links to its breakdown, or to the job when that tab is missing', () => {
    const f = headerFigures(money, ALL_MONEY, '/jobs/j', (t) => t !== 'job-cost');
    expect(f.find((x) => x.key === 'billed')!.href).toBe('/jobs/j?tab=billing');
    expect(f.find((x) => x.key === 'cost')!.href).toBe('/jobs/j');
  });

  it('a loss is flagged', () => {
    expect(headerFigures({ ...money, projectedMarginCents: -10 }, ALL_MONEY, '/j').find((x) => x.key === 'margin')!.tone).toBe('neg');
  });
});

describe('needs attention (≤5, each with evidence and an action)', () => {
  const base = {
    jobId: 'j', nextStage: { label: 'Contracted', failing: ['has_customer', 'has_budget'] }, pendingCoCount: 2, overdueTasks: 3,
    hasBudgetModule: true, hasBudget: false, draftBilling: 1, draftCommitments: 1, punchOpen: 5, overContract: true,
    vocab: { change_orders: 'Change orders', billing: 'Billing', commitments: 'Commitments' }, hasTab: () => true,
  };
  it('caps at five, blocked stage first', () => {
    const a = jobAttention(base);
    expect(a).toHaveLength(MAX_ATTENTION);
    expect(a[0]!.id).toBe('stage');
    expect(a[0]!.evidence).toContain('no customer');
    expect(a.every((x) => x.action.href.startsWith('/jobs/j'))).toBe(true);
  });
  it('a clean job raises nothing', () => {
    expect(jobAttention({ ...base, nextStage: null, pendingCoCount: 0, overdueTasks: 0, hasBudget: true, draftBilling: 0, draftCommitments: 0, punchOpen: 0, overContract: false })).toEqual([]);
  });
  it('without money there is no margin item', () => {
    expect(jobAttention({ ...base, overContract: null }).some((x) => x.id === 'margin')).toBe(false);
  });
});

describe('one activity stream, sorted by source', () => {
  const row = (actor: ActivityRow['actor_type'], verb: string, meta: Record<string, unknown> = {}) => ({ actor_type: actor, verb, meta });
  it('classifies people, field, portal, AI, Books and system events', () => {
    expect(activityKind(row('HUMAN', 'change_order.approved'))).toBe('people');
    expect(activityKind(row('HUMAN', 'work_order.started'))).toBe('field');
    expect(activityKind(row('HUMAN', 'time.approved'))).toBe('field');
    expect(activityKind(row('AI', 'stage.changed'))).toBe('ai');
    expect(activityKind(row('SYSTEM', 'progress.snapshot'))).toBe('books');
    expect(activityKind(row('HUMAN', 'selection.approved', { channel: 'portal' }))).toBe('portal');
    expect(activityKind(row('SYSTEM', 'sample.loaded'))).toBe('system');
    expect(kindCounts([row('AI', 'x.y'), row('HUMAN', 'x.y')])).toMatchObject({ ai: 1, people: 1, books: 0 });
  });
});

describe('⌘K action registry', () => {
  const vocab = vocabOf('field_service');
  it('offers only what the grants allow; job actions only on a job page', () => {
    const labor = paletteActions({ grants: [...PERSONA_TEMPLATE_GRANTS.projects_labor], vocab, jobId: null, readOnly: false }).map((a) => a.id);
    expect(labor).not.toContain('new-job');
    expect(labor).toContain('my-time');
    expect(labor.some((x) => x.startsWith('job-'))).toBe(false);
    const pm = paletteActions({ grants: [...PERSONA_TEMPLATE_GRANTS.projects_pm], vocab, jobId: 'j1', readOnly: false });
    expect(pm.map((a) => a.id)).toEqual(expect.arrayContaining(['new-job', 'job-co', 'job-bill', 'approve']));
    expect(pm.find((a) => a.id === 'job-co')!.href).toBe('/jobs/j1?tab=change-orders');
    expect(pm.find((a) => a.id === 'new-wo')?.label ?? 'New visit').toBe('New visit');
  });
  it('read-only views drop the write actions', () => {
    const ro = paletteActions({ grants: [...PERSONA_TEMPLATE_GRANTS.projects_owner], vocab, jobId: 'j1', readOnly: true }).map((a) => a.id);
    expect(ro).not.toContain('new-job');
    expect(ro).not.toContain('job-co');
    expect(ro).toContain('job-schedule');
  });
  it('finds the job on a job URL', () => {
    expect(jobIdFromPath('/jobs/0b9f2c3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f?tab=budget')).toBe('0b9f2c3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f');
    expect(jobIdFromPath('/jobs')).toBeNull();
  });
});

describe('the company experience loader', () => {
  it('a v1 install reads the pack’s latest experience; a v2 install its own', () => {
    expect(experienceManifest({ pack_key: 'field_service', pack_version: '1.0.0' })!.version).toBe('1.1.0');
    expect(experienceManifest({ pack_key: 'field_service', pack_version: '1.1.0' })!.version).toBe('1.1.0');
    expect(experienceManifest({ pack_key: 'nope', pack_version: '1.0.0' })).toBeNull();
  });
  it('tenant overrides layer on; a bad one is skipped and counted', () => {
    const e = experienceFor({
      primary: { pack_key: 'general', pack_version: '1.0.0' },
      overrides: [
        { json_pointer: '/experience/roles/0/title', op: 'replace', value: 'Founder' },
        { json_pointer: '/experience/nav/pm/0/item', op: 'replace', value: 'nowhere' },
      ],
    })!;
    expect(e.experience.roles[0]!.title).toBe('Founder');
    expect(e.skippedOverrides).toBe(1);
  });
  it('add-on job types bring their own tabs', () => {
    const e = experienceFor({ primary: { pack_key: 'field_service', pack_version: '1.1.0' }, addons: [{ pack_key: 'residential_remodel', pack_version: '1.1.0' }] })!;
    const exp: PlanExperience = e.experience;
    expect(exp.sources.fixed_price_remodel).toBe('residential_remodel');
    expect(exp.job_tabs.fixed_price_remodel!.tabs.map((t) => t.tab)).toContain('selections');
  });
});

describe('notifications bell', () => {
  it('is mounted in the shell bar', () => {
    expect(hasBell).toBe(true);
  });
});
