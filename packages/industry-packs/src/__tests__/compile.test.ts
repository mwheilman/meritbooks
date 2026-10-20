import { describe, expect, it } from 'vitest';
import {
  BANNED_WORDS_RE, CATALOG_KEYS, DEFAULT_VOCAB, MODULES, PlanCompileError, VOCAB_KEYS, canonicalJson, compilePlan,
  describePlan, diffPlans, planHash, resolveManifest, type WorkspacePlan,
} from '../index';

const LOC = 'loc_00000000-0000-0000-0000-000000000001';
const compileDefault = (key: string, includeSample = true) => compilePlan({ pack: key, locationId: LOC, includeSample });

describe.each([...CATALOG_KEYS])('compilePlan(%s, defaults)', (key) => {
  const plan = compileDefault(key);

  it('matches the golden snapshot', () => {
    expect(plan).toMatchSnapshot();
  });

  it('is complete and internally consistent', () => {
    expect(plan.schema_version).toBe(1);
    expect(plan.primary_pack.key).toBe(key);
    expect(Object.keys(plan.vocabulary).sort()).toEqual([...VOCAB_KEYS].sort());
    expect(Object.keys(plan.modules).sort()).toEqual([...MODULES].sort());
    const machines = new Set(plan.job_types.map((j) => j.stage_machine_key));
    for (const mk of machines) {
      const stages = plan.stages.filter((s) => s.machine_key === mk);
      expect(stages.filter((s) => s.is_initial)).toHaveLength(1);
      expect(stages.some((s) => s.is_terminal)).toBe(true);
      const keys = new Set(stages.map((s) => s.stage_key));
      for (const t of plan.transitions.filter((x) => x.machine_key === mk)) {
        expect(keys.has(t.from_stage)).toBe(true);
        expect(keys.has(t.to_stage)).toBe(true);
        if (t.approval_policy_key) expect(plan.approval_policies.some((p) => p.key === t.approval_policy_key)).toBe(true);
      }
    }
    for (const s of plan.stages) expect(machines.has(s.machine_key)).toBe(true);
    for (const j of plan.job_types) {
      expect(j.billing_modes).toContain(j.default_billing_mode);
      expect(Object.keys(j.modules).sort()).toEqual([...MODULES].sort());
      if (!j.modules.retainage) expect(j.default_retainage_pct).toBeNull();
    }
    for (const mk of MODULES) expect(plan.modules[mk]).toBe(plan.job_types.some((j) => j.modules[mk]));
    const codes = new Set(plan.cost_codes.map((c) => c.code));
    for (const c of plan.cost_codes) if (c.parent_code) expect(codes.has(c.parent_code)).toBe(true);
    for (const p of plan.price_book) if (p.cost_code) expect(codes.has(p.cost_code)).toBe(true);
    expect(plan.sample_job).not.toBeNull();
    for (const b of plan.sample_job!.budget) expect(codes.has(b.code)).toBe(true);
    for (const [jt, hint] of Object.entries(plan.books_proposal.rev_rec_by_job_type)) {
      expect(plan.job_types.find((j) => j.key === jt)?.rev_rec_hint).toBe(hint);
    }
  });

  it('is JSON-serializable without loss (passed verbatim to pm.apply_pack_plan)', () => {
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it('plan_hash is stable across runs and covers everything but answers and the sample job', () => {
    const again = compileDefault(key);
    expect(again.plan_hash).toBe(plan.plan_hash);
    expect(plan.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(compileDefault(key, false).plan_hash).toBe(plan.plan_hash);
    expect(planHash(plan)).toBe(plan.plan_hash);
    expect(compilePlan({ pack: key, locationId: 'loc_other' }).plan_hash).not.toBe(plan.plan_hash);
  });

  it('describes itself in the pack vocabulary without banned words', () => {
    const cards = describePlan(plan);
    const sections = cards.map((c) => c.section);
    expect(sections).toEqual(expect.arrayContaining(['job_types', 'stages', 'billing', 'cost_codes', 'modules', 'vocabulary', 'kpis', 'books', 'sample_job']));
    const text = JSON.stringify(cards);
    expect(text).not.toMatch(BANNED_WORDS_RE);
    expect(text).not.toMatch(/undefined|NaN|\[object/);
    const jobsWord = plan.vocabulary.jobs.toLowerCase();
    expect(cards[0].title.toLowerCase()).toContain(jobsWord);
    for (const c of cards) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.summary.length).toBeGreaterThan(0);
    }
  });
});

describe('plan_hash canonicalization', () => {
  it('canonicalJson ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: [3, { x: 2, y: 1 }] }, b: 1 }));
  });

  it('param key order does not change the plan or its hash', () => {
    const a = compilePlan({ pack: 'commercial_gc', locationId: LOC, params: { self_perform: true, billing_cutoff_day: 20, retainage_pct: 0.05 } });
    const b = compilePlan({ pack: 'commercial_gc', locationId: LOC, params: { retainage_pct: 0.05, billing_cutoff_day: 20, self_perform: true } });
    expect(a.plan_hash).toBe(b.plan_hash);
    expect(a).toEqual(b);
  });

  it('a reordered copy of a plan hashes the same', () => {
    const plan = compileDefault('field_service');
    const shuffled = JSON.parse(JSON.stringify(plan, Object.keys(plan).reverse())) as WorkspacePlan;
    const reordered = Object.fromEntries(Object.entries(plan).reverse()) as unknown as WorkspacePlan;
    expect(planHash(reordered)).toBe(plan.plan_hash);
    expect(shuffled.plan_hash).toBe(plan.plan_hash);
  });

  it('explicit answers equal to the defaults do not change the hash', () => {
    const base = compileDefault('residential_remodel');
    const explicit = compilePlan({
      pack: 'residential_remodel', locationId: LOC, includeSample: true,
      answers: { sells_design: true, deposit_pct: 0.3, remodel_billing: 'MILESTONE', does_cost_plus: false, small_jobs: false },
    });
    expect(explicit.plan_hash).toBe(base.plan_hash);
  });
});

describe('question effects', () => {
  it('enable_job_types (bool): turning off a governed job type removes it, its machine and its fields', () => {
    const on = compileDefault('field_service');
    const off = compilePlan({ pack: 'field_service', locationId: LOC, answers: { does_replacements: false } });
    expect(on.job_types.map((j) => j.key)).toContain('replacement_install');
    expect(off.job_types.map((j) => j.key)).not.toContain('replacement_install');
    expect(off.stages.some((s) => s.machine_key === 'fs_install')).toBe(false);
    expect(off.field_defs.some((f) => f.job_type_key === 'replacement_install')).toBe(false);
    expect(off.plan_hash).not.toBe(on.plan_hash);
  });

  it('enable_job_types (multi): only selected job types are installed', () => {
    const plan = compilePlan({ pack: 'real_estate_development', locationId: LOC, answers: { project_kinds: ['rental_development'] } });
    expect(plan.job_types.map((j) => j.key)).toEqual(['rental_development']);
    expect(plan.modules.lots_units).toBe(false);
    const both = compileDefault('real_estate_development');
    expect(both.job_types.map((j) => j.key)).toEqual(['for_sale_development', 'land_development']);
  });

  it('toggle_module: an answer turns a module off for every job type and company-wide', () => {
    const plan = compilePlan({ pack: 'field_service', locationId: LOC, answers: { sells_memberships: false } });
    expect(plan.modules.service_agreements).toBe(false);
    expect(plan.job_types.map((j) => j.key)).not.toContain('maintenance_visit');
    const gc = compilePlan({ pack: 'commercial_gc', locationId: LOC, answers: { collects_compliance: false } });
    expect(gc.modules.compliance).toBe(false);
  });

  it('toggle_module on never overrides a job type that sets the module off', () => {
    const plan = compilePlan({ pack: 'specialty_trade', locationId: LOC, answers: { gc_requires_compliance: true, does_service: true } });
    expect(plan.job_types.find((j) => j.key === 'subcontract')!.modules.compliance).toBe(true);
    expect(plan.job_types.find((j) => j.key === 'trade_service_call')!.modules.compliance).toBe(false);
  });

  it('set_default_billing changes the default for the named job type only', () => {
    const plan = compilePlan({ pack: 'residential_remodel', locationId: LOC, answers: { remodel_billing: 'PROGRESS_PCT', does_cost_plus: true } });
    expect(plan.job_types.find((j) => j.key === 'fixed_price_remodel')!.default_billing_mode).toBe('PROGRESS_PCT');
    expect(plan.job_types.find((j) => j.key === 'cost_plus_remodel')!.default_billing_mode).toBe('TIME_MATERIALS');
    const fs = compilePlan({ pack: 'field_service', locationId: LOC, answers: { repair_pricing: 'TIME_MATERIALS' } });
    expect(fs.job_types.find((j) => j.key === 'service_call')!.default_billing_mode).toBe('TIME_MATERIALS');
  });

  it('set_param: an explicit answer sets the param; retainage_pct then applies to every retainage job type', () => {
    const def = compileDefault('commercial_gc');
    expect(def.job_types.find((j) => j.key === 'gmp_cost_plus')!.default_retainage_pct).toBe(0.05);
    expect(def.job_types.find((j) => j.key === 'small_work')!.default_retainage_pct).toBeNull();
    const plan = compilePlan({ pack: 'commercial_gc', locationId: LOC, answers: { retainage_pct: 0.05 } });
    expect(plan.params.retainage_pct).toBe(0.05);
    for (const j of plan.job_types) {
      expect(j.default_retainage_pct).toBe(j.modules.retainage ? 0.05 : null);
    }
    const fs = compilePlan({ pack: 'field_service', locationId: LOC, answers: { primary_trade: 'plumbing' } });
    expect(fs.params.primary_trade).toBe('plumbing');
  });

  it('precedence: explicit answer beats explicit param beats defaults', () => {
    const p = compilePlan({ pack: 'flooring', locationId: LOC, params: { deposit_pct: 0.4 } });
    expect(p.params.deposit_pct).toBe(0.4);
    const a = compilePlan({ pack: 'flooring', locationId: LOC, params: { deposit_pct: 0.4 }, answers: { deposit_pct: 0.25 } });
    expect(a.params.deposit_pct).toBe(0.25);
  });

  it('uses_retainage param turns retainage on only for progress-billed job types', () => {
    const plan = compilePlan({ pack: 'flooring', locationId: LOC, params: { uses_retainage: true }, answers: { commercial_work: true } });
    expect(plan.job_types.find((j) => j.key === 'commercial_flooring')!.modules.retainage).toBe(true);
    expect(plan.job_types.find((j) => j.key === 'retail_install')!.modules.retainage).toBe(false);
    const none = compilePlan({ pack: 'commercial_gc', locationId: LOC, params: { uses_retainage: false } });
    expect(none.modules.retainage).toBe(false);
    for (const j of none.job_types) expect(j.default_retainage_pct).toBeNull();
  });

  it('records resolved answers (defaults included) on the plan', () => {
    const plan = compilePlan({ pack: 'general', locationId: LOC, answers: { bills_hourly: false } });
    expect(plan.answers).toEqual({ tracks_time: true, bills_hourly: false, fixed_billing: 'FIXED', uses_pos: false });
    expect(plan.job_types.map((j) => j.key)).toEqual(['fixed_price', 'milestone_project']);
  });
});

describe('errors', () => {
  it('rejects invalid params, unknown params, invalid answers and unknown questions', () => {
    expect(() => compilePlan({ pack: 'commercial_gc', locationId: LOC, params: { retainage_pct: 0.5 } })).toThrow(PlanCompileError);
    expect(() => compilePlan({ pack: 'commercial_gc', locationId: LOC, params: { made_up: 1 } })).toThrow(PlanCompileError);
    expect(() => compilePlan({ pack: 'commercial_gc', locationId: LOC, answers: { retainage_pct: 'ten' } })).toThrow(PlanCompileError);
    expect(() => compilePlan({ pack: 'commercial_gc', locationId: LOC, answers: { not_a_question: true } })).toThrow(PlanCompileError);
    expect(() => compilePlan({ pack: 'commercial_gc', locationId: LOC, answers: { 'flooring.deposit_pct': 0.5 } })).toThrow(PlanCompileError);
    expect(() => compilePlan({ pack: 'real_estate_development', locationId: LOC, answers: { project_kinds: [] } })).toThrow(/every job type/);
    expect(() => compilePlan({ pack: 'nope', locationId: LOC })).toThrow(/Unknown industry pack/);
    expect(() => compilePlan({ pack: 'general', locationId: '' })).toThrow(/locationId/);
  });

  it('sample job is dropped when its job type is turned off', () => {
    const plan = compilePlan({ pack: 'general', locationId: LOC, includeSample: true, answers: {} });
    expect(plan.sample_job?.jobType).toBe('fixed_price');
    const prof = compilePlan({ pack: 'professional_services', locationId: LOC, includeSample: true, answers: { sells_fixed_fee: false } });
    expect(prof.sample_job).toBeNull();
  });
});

describe('add-on packs', () => {
  const plan = compilePlan({
    pack: 'commercial_gc', addons: ['field_service'], locationId: LOC,
    answers: { 'field_service.does_replacements': false },
  });

  it('appends add-on job types, machines and cost codes; primary vocabulary wins', () => {
    const keys = plan.job_types.map((j) => j.key);
    expect(keys.slice(0, 4)).toEqual(['lump_sum', 'gmp_cost_plus', 'tenant_improvement', 'small_work']);
    expect(keys).toContain('service_call');
    expect(keys).not.toContain('replacement_install');
    expect(plan.stages.some((s) => s.machine_key === 'fs_service')).toBe(true);
    expect(plan.cost_codes.some((c) => c.code === 'SVC-LAB')).toBe(true);
    expect(plan.cost_codes.some((c) => c.code === '03 30 00')).toBe(true);
    expect(plan.vocabulary.job).toBe('Project');
    expect(plan.addon_packs).toEqual([{ key: 'field_service', version: '1.0.0' }]);
    expect(plan.modules.dispatch).toBe(true);
    expect(plan.answers['field_service.does_replacements']).toBe(false);
    expect(plan.price_book.length).toBe(resolveManifest('field_service').priceBook.length);
    expect(new Set(plan.cost_codes.map((c) => c.code)).size).toBe(plan.cost_codes.length);
  });

  it('dedupes approval policies by key with the primary winning', () => {
    const co = plan.approval_policies.filter((p) => p.key === 'change_order_approval');
    expect(co).toHaveLength(1);
    expect(co[0].tiers[0].max_cents).toBe(1_000_000);
  });
});

describe('diffPlans', () => {
  it('reports nothing for identical plans', () => {
    const d = diffPlans(compileDefault('flooring'), compileDefault('flooring'));
    expect(d.identical).toBe(true);
    for (const s of Object.values(d.sections)) expect(s).toEqual({ added: [], removed: [], changed: [] });
  });

  it('reports added job types, stages, fields and changed modules and defaults', () => {
    const prev = compileDefault('flooring');
    const next = compilePlan({ pack: 'flooring', locationId: LOC, includeSample: true, answers: { commercial_work: true, deposit_pct: 0.3 } });
    const d = diffPlans(prev, next);
    expect(d.identical).toBe(false);
    expect(d.sections.job_types.added).toEqual(['commercial_flooring']);
    expect(d.sections.stages.added.length).toBe(9);
    expect(d.sections.modules.changed.map((c) => c.key)).toEqual(expect.arrayContaining(['retainage', 'compliance', 'schedule']));
    expect(d.sections.params.changed).toEqual([{ key: 'deposit_pct', before: 0.5, after: 0.3 }]);
    expect(d.sections.books_proposal.added).toEqual(['rev_rec:commercial_flooring']);
    const back = diffPlans(next, prev);
    expect(back.sections.job_types.removed).toEqual(['commercial_flooring']);
  });
});

describe('vocabulary in plans', () => {
  it('fills every base key and applies real industry terms', () => {
    expect(compileDefault('equipment_dealer').vocabulary.job).toBe('Repair order');
    expect(compileDefault('commercial_gc').vocabulary.draw).toBe('Pay application');
    expect(compileDefault('field_service').vocabulary.work_order).toBe('Visit');
    expect(compileDefault('flooring').vocabulary.crews).toBe('Installers');
    expect(compileDefault('general').vocabulary).toEqual({ ...DEFAULT_VOCAB });
  });
});
