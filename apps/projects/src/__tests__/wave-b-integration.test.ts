/**
 * Wave B integration (1118 portals, 1119 residential, 1120 commercial, 1121 imports, 1122 industry
 * depth): who reaches the new screens, which packs turn them on in the rail, the new job tabs, the
 * install-time seeds, money keys, and the pending notification recipes for the Wave B events.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULES, compilePlan, resolveVocabulary, type ModuleKey } from '@meritbooks/industry-packs';
import { PACK_SCREENS, canReach, packScreensInUse, railNav, type NavAccess } from '@/lib/nav';
import { PERSONA_GROUP, type PersonaKey } from '@/lib/access/types';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { MONEY_KEYS } from '@/lib/access/money-keys';
import { resolveJobTabs } from '@/lib/pm/job-tabs';
import { seedsFor } from '@/lib/onboarding/seed';
import {
  CUSTOMER_EVENTS, EVENT_INFO, INTERNAL_EVENTS, RECIPE_CODES, RECIPE_PERSONAS, SECRET_BEARING_EVENTS, recipeDefaults,
} from '@/lib/notify/recipes';

const LOC = '00000000-0000-4000-8000-000000000001';
const as = (p: PersonaKey): NavAccess => ({ group: PERSONA_GROUP[p], grants: PERSONA_TEMPLATE_GRANTS[p] });

function railFor(pack: string, p: PersonaKey): string[] {
  const plan = compilePlan({ pack, locationId: LOC });
  return railNav({
    context: 'client', vocab: resolveVocabulary(plan.vocabulary), modules: MODULES.filter((m) => plan.modules[m]) as ModuleKey[],
    booksPresent: true, companyCount: 1, packKeys: [pack], experience: plan.experience, access: as(p),
  }).flatMap((g) => [...g.items, ...g.more].map((x) => x.href));
}

function tabsFor(pack: string, jobType?: string) {
  const plan = compilePlan({ pack, locationId: LOC });
  const jt = jobType ? plan.job_types.find((j) => j.key === jobType)! : plan.job_types[0]!;
  const modules = new Set(MODULES.filter((m) => jt.modules[m]) as ModuleKey[]);
  const r = resolveJobTabs({ experience: plan.experience, jobTypeKey: jt.key, modules, vocab: resolveVocabulary(plan.vocabulary) });
  return { r, all: [...r.visible, ...r.more] };
}

describe('who reaches the Wave B screens', () => {
  const ROUTES = ['/portal-access', '/proposals', '/homes', '/communities', '/change-events', '/rfis', '/submittals', '/meetings',
    '/compliance', '/wip', '/setup/imports', '/flooring', '/flooring/pay', '/design', '/development'];
  it('the owner reaches every one', () => {
    for (const r of ROUTES) expect(canReach(as('projects_owner'), r), r).toBe(true);
  });
  it('crew never reaches money, compliance, development or imports', () => {
    for (const r of ['/compliance', '/wip', '/development', '/setup/imports', '/proposals']) expect(canReach(as('projects_labor'), r), r).toBe(false);
  });
  it('a PM works RFIs, submittals, meetings and change events', () => {
    for (const r of ['/rfis', '/submittals', '/meetings', '/change-events']) expect(canReach(as('projects_pm'), r), r).toBe(true);
  });
});

describe('packs turn the industry screens on in the rail', () => {
  it('pseudo-modules follow the installed packs', () => {
    expect(packScreensInUse(['commercial_gc'])).toEqual(['pack:commercial']);
    expect(packScreensInUse(['home_builder']).sort()).toEqual(['pack:homes', 'pack:residential']);
    expect(packScreensInUse([])).toEqual([]);
    for (const packs of Object.values(PACK_SCREENS)) expect(packs.length).toBeGreaterThan(0);
  });
  it('commercial GC: RFIs, submittals, meetings, change events, compliance, WIP; no homes', () => {
    const h = railFor('commercial_gc', 'projects_owner');
    expect(h).toEqual(expect.arrayContaining(['/rfis', '/submittals', '/meetings', '/change-events', '/compliance', '/wip']));
    expect(h).not.toContain('/homes');
    expect(h).not.toContain('/flooring');
  });
  it('home builder: homes and communities; remodeler: proposals; neither shows the GC screens', () => {
    expect(railFor('home_builder', 'projects_owner')).toEqual(expect.arrayContaining(['/homes', '/communities']));
    const rem = railFor('residential_remodel', 'projects_owner');
    expect(rem).toContain('/proposals');
    expect(rem).not.toContain('/submittals');
  });
  it('flooring, design and development get their own screens', () => {
    expect(railFor('flooring', 'projects_office_manager')).toEqual(expect.arrayContaining(['/flooring']));
    expect(railFor('interior_design', 'projects_owner')).toContain('/design');
    expect(railFor('real_estate_development', 'projects_owner')).toContain('/development');
    expect(railFor('field_service', 'projects_owner')).not.toContain('/development');
  });
  it('installers keep the four-screen rail (installer pay is an office tool)', () => {
    expect(railFor('flooring', 'projects_labor')).not.toContain('/flooring/pay');
  });
});

describe('job tabs for the new kinds', () => {
  it('home builder puts the Home tab second', () => {
    const { r } = tabsFor('home_builder');
    expect(r.visible[1]?.value).toBe('home');
  });
  it('flooring, design and development jobs open their depth tab', () => {
    expect(tabsFor('flooring').all.map((t) => t.value)).toContain('flooring-job');
    expect(tabsFor('interior_design').all.map((t) => t.value)).toContain('design-project');
    expect(tabsFor('real_estate_development').all.map((t) => t.value)).toContain('development');
  });
  it('specialty trade has productivity, changes and T&M, all live', () => {
    const { all } = tabsFor('specialty_trade');
    expect(all.map((t) => t.value)).toEqual(expect.arrayContaining(['productivity', 'change-events', 'tm-tickets']));
    expect(all.filter((t) => ['productivity', 'change-events', 'tm-tickets', 'rfis'].includes(t.value)).some((t) => t.later)).toBe(false);
  });
});

describe('pack install seeds', () => {
  it('commercial packs seed the templates; residential packs seed settings with the business kind', () => {
    expect(seedsFor(['commercial_gc'])).toEqual({ steps: ['commercial_templates'], businessKind: null });
    expect(seedsFor(['specialty_trade']).steps).toEqual(['commercial_templates']);
    expect(seedsFor(['residential_remodel'])).toEqual({ steps: ['residential_settings'], businessKind: 'remodel' });
    expect(seedsFor(['home_builder']).businessKind).toBe('custom');
    expect(seedsFor(['residential_remodel', 'home_builder']).businessKind).toBe('hybrid');
    expect(seedsFor(['field_service'])).toEqual({ steps: [], businessKind: null });
  });
});

describe('commercial money keys', () => {
  it('change events, WIP and sub pay apps are declared', () => {
    for (const k of ['change_event', 'wip', 'sub_pay_app'] as const) expect(MONEY_KEYS[k], k).toBeDefined();
  });
});

const WAVE_B_INTERNAL = ['portal.activity', 'change_order.requested', 'trade.schedule_response', 'rfi.assigned', 'submittal.review_requested',
  'sub_pay_app.review', 'compliance.expiring', 'eac.submitted', 'meeting.minutes', 'meeting.item_assigned', 'observation.assigned',
  'productivity.fade', 'tm.signature_needed'] as const;
const WAVE_B_OUTBOUND = ['customer.portal_access', 'trade.schedule_request', 'trade.bid_invite', 'trade.po_ready'] as const;

describe('Wave B notification recipes (seeded by 1114; parity-tested against the DB)', () => {
  const sql = ['1118_pm_portals.sql', '1119_pm_residential.sql', '1120_pm_commercial_depth.sql', '1114_notifications.sql']
    .map((f) => readFileSync(join(__dirname, '../../../../packages/supabase/migrations', f), 'utf8')).join('\n');

  it('every Wave B event is registered and is in the code catalog (internal → recipes, outbound → customer events)', () => {
    for (const e of [...WAVE_B_INTERNAL, ...WAVE_B_OUTBOUND]) expect(sql, e).toContain(`('${e}',`);
    for (const e of WAVE_B_INTERNAL) {
      expect((INTERNAL_EVENTS as readonly string[]).includes(e), e).toBe(true);
      expect(recipeDefaults().filter((r) => r.event === e)).toHaveLength(RECIPE_PERSONAS.length);
    }
    for (const e of WAVE_B_OUTBOUND) expect((CUSTOMER_EVENTS as readonly string[]).includes(e), e).toBe(true);
    expect([...SECRET_BEARING_EVENTS]).toEqual(['customer.portal_access']);
  });

  it('a code per persona; mandatory events never default the inbox off', () => {
    for (const e of WAVE_B_INTERNAL) {
      expect(RECIPE_CODES[e], e).toHaveLength(RECIPE_PERSONAS.length);
      expect(RECIPE_CODES[e]).not.toContain('-');
      expect(EVENT_INFO[e].mandatory).toBe(true);
    }
  });

  it('the people who act get push: the PM on field change requests, the accountant on sub pay apps', () => {
    const at = (p: string, e: string) => recipeDefaults().find((r) => r.persona === p && r.event === e)!;
    expect(at('projects_pm', 'change_order.requested').push).toBe('instant');
    expect(at('projects_project_accountant', 'sub_pay_app.review').push).toBe('instant');
    expect(at('projects_owner', 'meeting.minutes').email).toBe('digest');
  });
});
