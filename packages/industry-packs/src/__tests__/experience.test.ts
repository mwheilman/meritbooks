import { describe, expect, it } from 'vitest';
import {
  CATALOG_KEYS, PERSONA_GROUPS, PERSONA_TEMPLATES, PLAN_SCHEMA_VERSION, PlanCompileError, applyExperienceOverrides, applyPatch, parsePointer,
  compileExperience, compilePlan, getPack, homeFor, jobTabsFor, latestVersions, listVersions, mobileActionsFor,
  multiJobViewFor, navFor, resolveManifest, resolveManifestInput, roleTitleFor, scheduleViewFor, validateManifest,
  type PlanExperience,
} from '../index';

const LOC = 'loc_00000000-0000-0000-0000-000000000001';
const exp = (key: string): PlanExperience => compilePlan({ pack: key, locationId: LOC }).experience;
const tabs = (key: string, jt: string) => jobTabsFor(exp(key), jt)!.tabs.map((t) => t.label ?? t.tab);
const navItems = (key: string, g: (typeof PERSONA_GROUPS)[number]) => navFor(exp(key), g)!.map((e) => e.label ?? e.item);

describe('manifest v2: every published pack validates and fills every slot', () => {
  it('the latest version of all 12 packs is v2 and validates', () => {
    expect(CATALOG_KEYS).toHaveLength(12);
    for (const key of CATALOG_KEYS) {
      const r = validateManifest(resolveManifestInput(key));
      expect(r.issues, key).toEqual([]);
      expect(r.ok, key).toBe(true);
      expect(resolveManifest(key).nav, key).toBeDefined();
    }
  });

  it('compiles to plan schema 2 with an experience section', () => {
    expect(PLAN_SCHEMA_VERSION).toBe(2);
    for (const key of CATALOG_KEYS) {
      const plan = compilePlan({ pack: key, locationId: LOC });
      expect(plan.schema_version).toBe(2);
      expect(plan.experience.sources).toEqual(Object.fromEntries(plan.job_types.map((j) => [j.key, key])));
    }
  });

  it.each([...CATALOG_KEYS])('%s: an industry title for every persona template', (key) => {
    const e = exp(key);
    for (const t of PERSONA_TEMPLATES) expect(roleTitleFor(e, t), `${key} ${t}`).toBeTruthy();
  });

  it.each([...CATALOG_KEYS])('%s: a rail and a home for every persona group', (key) => {
    const e = exp(key);
    for (const g of PERSONA_GROUPS) {
      expect(navFor(e, g)?.length, `${key} nav ${g}`).toBeGreaterThan(0);
      expect(homeFor(e, g)?.length, `${key} home ${g}`).toBeGreaterThan(0);
    }
  });

  it.each([...CATALOG_KEYS])('%s: every job type resolves tabs, a default tab, a schedule view and field actions', (key) => {
    const plan = compilePlan({ pack: key, locationId: LOC });
    for (const jt of plan.job_types) {
      const set = jobTabsFor(plan.experience, jt.key);
      expect(set, `${key}/${jt.key}`).not.toBeNull();
      expect(set!.tabs.map((t) => t.tab)).toContain(set!.default_tab);
      expect(new Set(set!.tabs.map((t) => t.tab)).size).toBe(set!.tabs.length);
      expect(scheduleViewFor(plan.experience, jt.key), `${key}/${jt.key} schedule`).toBeTruthy();
      expect(mobileActionsFor(plan.experience, 'labor', jt.key).length, `${key}/${jt.key} labor`).toBeGreaterThan(0);
    }
    expect(plan.experience.doc_templates.length).toBeGreaterThan(0);
    expect(plan.experience.checklists.length).toBeGreaterThan(0);
  });
});

describe('Industry × experience table (UX seat §3a)', () => {
  it('commercial_gc: budget-first project tabs with pay apps, RFIs and directory', () => {
    expect(tabs('commercial_gc', 'lump_sum')).toEqual([
      'overview', 'budget', 'schedule', 'commitments', 'Changes', 'RFIs', 'pay_apps', 'submittals', 'Daily reports', 'meetings',
      'buyout', 'closeout', 'directory', 'Safety & inspections', 'documents', 'specifications', 'correspondence', 'Monthly review',
      'Owner portal', 'billing',
    ]);
    expect(tabs('commercial_gc', 'small_work')).not.toContain('RFIs');
    expect(navItems('commercial_gc', 'pm')).toEqual(expect.arrayContaining(['Change events', 'pay_apps', 'project_review', 'Reports']));
  });

  it('field_service: jobs open on Visits; the dispatch board is the schedule', () => {
    const e = exp('field_service');
    expect(jobTabsFor(e, 'service_call')!.default_tab).toBe('work_orders');
    expect(tabs('field_service', 'service_call').slice(0, 4)).toEqual(['work_orders', 'Options', 'equipment', 'Invoice & payments']);
    expect(jobTabsFor(e, 'replacement_install')!.default_tab).toBe('overview');
    expect(scheduleViewFor(e, 'service_call')).toBe('dispatch');
    expect(scheduleViewFor(e, 'replacement_install')).toBe('gantt');
    expect(mobileActionsFor(e, 'labor', 'service_call')[0]).toBe('on_my_way');
    expect(navItems('field_service', 'admin')).toEqual(expect.arrayContaining(['calls', 'dispatch', 'price_book', 'capacity', 'Invoices']));
    expect(roleTitleFor(e, 'projects_labor')).toBe('Technician');
    expect(roleTitleFor(e, 'projects_sales')).toBe('Comfort advisor');
  });

  it('equipment_dealer: RO tabs start on lines; warranty repairs add the claim', () => {
    expect(tabs('equipment_dealer', 'customer_repair').slice(0, 3)).toEqual(['Lines', 'parts', 'Labor']);
    expect(tabs('equipment_dealer', 'warranty_repair')).toContain('warranty_claim');
    expect(tabs('equipment_dealer', 'customer_repair')).not.toContain('warranty_claim');
    expect(navItems('equipment_dealer', 'admin')).toEqual(expect.arrayContaining(['Service', 'Units', 'parts_counter', 'tech_board', 'warranty_deadlines']));
    expect(multiJobViewFor(exp('equipment_dealer'), 'admin')).toBe('service_board');
  });

  it('schedule defaults per pack (§3c)', () => {
    expect(scheduleViewFor(exp('commercial_gc'), 'lump_sum')).toBe('gantt');
    expect(multiJobViewFor(exp('commercial_gc'), 'supervisor')).toBe('lookahead');
    expect(multiJobViewFor(exp('specialty_trade'), 'pm')).toBe('crew_board');
    expect(multiJobViewFor(exp('manufacturing_eto'), 'pm')).toBe('production_capacity');
    expect(scheduleViewFor(exp('flooring'), 'retail_install')).toBe('install_board');
    expect(scheduleViewFor(exp('interior_design'), 'full_service_design')).toBe('calendar');
    expect(scheduleViewFor(exp('real_estate_development'), 'for_sale_development')).toBe('milestone_timeline');
    expect(multiJobViewFor(exp('professional_services'), 'pm')).toBe('resource_planner');
  });

  it('only the shop runs a kiosk', () => {
    for (const key of CATALOG_KEYS) expect(exp(key).kiosk, key).toBe(key === 'manufacturing_eto');
  });

  it('the PM rail differs per industry', () => {
    const rails = new Set(CATALOG_KEYS.map((k) => navItems(k, 'pm').join('|')));
    expect(rails.size).toBe(12);
  });
});

describe('old manifests keep loading', () => {
  it('v1 versions stay published and compile', () => {
    for (const key of CATALOG_KEYS) {
      const versions = listVersions(key);
      expect(versions.length, key).toBeGreaterThanOrEqual(2);
      const oldest = versions[versions.length - 1]!;
      const m = getPack(key, oldest)!;
      expect(m.version).toBe(oldest);
      const plan = compilePlan({ pack: key, version: oldest, locationId: LOC });
      expect(plan.primary_pack.version).toBe(oldest);
      expect(plan.schema_version).toBe(2);
    }
    expect(latestVersions().equipment_dealer).toBe('1.2.0');
  });

  it('a v1 manifest without experience slots still parses (slots are optional)', () => {
    const raw = { ...resolveManifestInput('general', '1.0.0') };
    for (const k of ['roles', 'nav', 'home', 'jobTabs', 'mobile', 'schedule', 'docTemplates', 'checklists'] as const) delete raw[k];
    expect(validateManifest(raw).ok).toBe(true);
  });
});

describe('tenant overrides (pm.pack_overrides, RFC 6901)', () => {
  it('relabels a rail item and drops a tab; layered in order', () => {
    const base = exp('residential_remodel');
    const idx = base.nav.pm!.findIndex((e) => e.item === 'change_orders');
    const r = applyExperienceOverrides(base, [
      { json_pointer: `/experience/nav/pm/${idx}/label`, op: 'replace', value: 'Change requests' },
      { json_pointer: '/experience/job_tabs/*/tabs/8', op: 'remove' }, // the portal tab ("Client view")
      { json_pointer: '/modules/selections', op: 'replace', value: false },
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.applied).toHaveLength(2);
    expect(r.experience.nav.pm![idx]!.label).toBe('Change requests');
    expect(r.experience.job_tabs['*']!.tabs.map((t) => t.tab)).not.toContain('portal');
    expect(base.job_tabs['*']!.tabs.map((t) => t.tab)).toContain('portal');
  });

  it('a delta that breaks the shape is skipped, never half-applied', () => {
    const base = exp('general');
    const r = applyExperienceOverrides(base, [
      { json_pointer: '/experience/nav/pm/0/item', op: 'replace', value: 'teleporter' },
      { json_pointer: '/experience/job_tabs/*/default_tab', op: 'replace', value: 'draws' },
      { json_pointer: '/experience/nope/x', op: 'replace', value: 1 },
    ]);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toHaveLength(3);
    expect(r.experience).toEqual(base);
  });

  it('compilePlan consumes overrides (experience + vocabulary) and refuses other roots', () => {
    const plan = compilePlan({
      pack: 'general', locationId: LOC,
      overrides: [
        { json_pointer: '/vocabulary/job', op: 'replace', value: 'Work order' },
        { json_pointer: '/experience/kiosk', op: 'replace', value: true },
        { json_pointer: '/modules/time', op: 'replace', value: false },
      ],
    });
    expect(plan.vocabulary.job).toBe('Work order');
    expect(plan.experience.kiosk).toBe(true);
    expect(plan.plan_hash).not.toBe(compilePlan({ pack: 'general', locationId: LOC }).plan_hash);
    expect(() => compilePlan({ pack: 'general', locationId: LOC, overrides: [{ json_pointer: '/job_types/0', op: 'remove' }] })).toThrow(PlanCompileError);
    expect(() => compilePlan({ pack: 'general', locationId: LOC, overrides: [{ json_pointer: '/experience/kiosk', op: 'replace', value: 'yes' }] })).toThrow(PlanCompileError);
  });
});

describe('add-on packs bring their own tabs (PLT-05)', () => {
  it('field_service + residential_remodel: remodel jobs get remodel tabs and the rail gains selections', () => {
    const plan = compilePlan({ pack: 'field_service', addons: ['residential_remodel'], locationId: LOC });
    const e = plan.experience;
    expect(e.sources.service_call).toBe('field_service');
    expect(e.sources.fixed_price_remodel).toBe('residential_remodel');
    expect(jobTabsFor(e, 'fixed_price_remodel')!.tabs.map((t) => t.tab)).toContain('selections');
    expect(jobTabsFor(e, 'service_call')!.default_tab).toBe('work_orders');
    expect(scheduleViewFor(e, 'fixed_price_remodel')).toBe('gantt');
    expect(navFor(e, 'pm')!.map((x) => x.item)).toContain('selections');
    expect(roleTitleFor(e, 'projects_labor')).toBe('Technician');
  });

  it('compileExperience without add-ons equals the pack experience', () => {
    const m = resolveManifest('flooring');
    const plan = compilePlan({ pack: 'flooring', locationId: LOC });
    expect(compileExperience({ manifest: m, jobTypeKeys: plan.job_types.map((j) => j.key) })).toEqual(plan.experience);
  });
});

describe('overrides can never reach Object.prototype (security review)', () => {
  const base = () => compilePlan({ pack: 'general', locationId: LOC }).experience;
  const attacks = [
    { json_pointer: '/experience/__proto__/mask', op: 'add' as const, value: false },
    { json_pointer: '/experience/constructor/prototype/mask', op: 'add' as const, value: false },
    { json_pointer: '/experience/job_tabs/__proto__', op: 'add' as const, value: { tabs: [{ tab: 'overview', label: null }], default_tab: 'overview' } },
    { json_pointer: '/experience/job_tabs/x', op: 'add' as const, value: JSON.parse('{"__proto__":{"mask":false},"tabs":[{"tab":"overview","label":null}],"default_tab":"overview"}') as unknown },
    { json_pointer: '/experience/nav/pm/prototype', op: 'add' as const, value: 1 },
  ];

  it('parsePointer refuses __proto__, constructor and prototype segments', () => {
    expect(() => parsePointer('/experience/__proto__/mask')).toThrow(/forbidden/);
    expect(() => parsePointer('/a/constructor')).toThrow(/forbidden/);
    expect(() => parsePointer('/a/prototype/b')).toThrow(/forbidden/);
    expect(parsePointer('/experience/nav/pm/0/label')).toEqual(['experience', 'nav', 'pm', '0', 'label']);
  });

  it('every attack is skipped and nothing global changes', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    // A raw JSON value with an own "__proto__" key, as JSON.parse (and the database) yields it.
    const jsonAttack = { json_pointer: '/experience/kiosk', op: 'replace' as const, value: JSON.parse('{"__proto__":{"mask":false}}') };
    const r = applyExperienceOverrides(base(), [...attacks, jsonAttack]);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toHaveLength(attacks.length + 1);
    expect(({} as Record<string, unknown>).mask).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(Object.getPrototypeOf(r.experience.job_tabs)).toBe(Object.prototype);
  });

  it('an object literal __proto__ (a prototype, not a key) is copied as plain data only', () => {
    const r = applyExperienceOverrides(base(), [{ json_pointer: '/experience/job_tabs/x', op: 'add', value: { __proto__: { mask: false }, tabs: [{ tab: 'overview', label: null }], default_tab: 'overview' } }]);
    expect((r.experience.job_tabs.x as unknown as Record<string, unknown>).mask).toBeUndefined();
    expect(({} as Record<string, unknown>).mask).toBeUndefined();
  });

  it('applyPatch refuses forbidden keys inside a value', () => {
    expect(() => applyPatch({ a: {} }, { json_pointer: '/a/b', op: 'add', value: JSON.parse('{"__proto__":{"x":1}}') })).toThrow(/forbidden/);
    expect(() => applyPatch({ a: {} }, { json_pointer: '/a/b', op: 'add', value: { constructor: 1 } })).toThrow(/forbidden/);
  });

  it('compilePlan refuses them as a PlanCompileError', () => {
    for (const a of attacks.slice(0, 2)) expect(() => compilePlan({ pack: 'general', locationId: LOC, overrides: [a] })).toThrow(PlanCompileError);
    expect(() => compilePlan({ pack: 'general', locationId: LOC, overrides: [{ json_pointer: '/constructor/x', op: 'add', value: 1 }] })).toThrow(PlanCompileError);
  });

  it('resolvers read own properties only', () => {
    const e = base();
    expect(jobTabsFor(e, 'constructor')).toEqual(jobTabsFor(e, '*'));
    expect(scheduleViewFor(e, 'toString')).toBe(scheduleViewFor(e, '*'));
    expect(mobileActionsFor(e, 'labor', 'hasOwnProperty')).toEqual(mobileActionsFor(e, 'labor', '*'));
  });

  it('a pack key can never be constructor or prototype', () => {
    const raw = { ...resolveManifestInput('general') };
    raw.jobTabs = { ...(raw.jobTabs ?? {}), constructor: { tabs: ['overview', 'budget'] as const } as never };
    expect(validateManifest(raw).ok).toBe(false);
  });
});
