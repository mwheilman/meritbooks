import { describe, expect, it } from 'vitest';
import {
  CATALOG_KEYS, METRICS, MODULES, PACK_MANIFESTS, VOCAB_KEYS, getPack, getPackInput, latestVersions, listPacks,
  resolveInput, resolveManifest, resolveManifestInput, validateManifest, type PackManifestInput,
} from '../index';

const EXPECTED_KEYS = [
  'general', 'commercial_gc', 'specialty_trade', 'residential_remodel', 'home_builder', 'field_service',
  'manufacturing_eto', 'flooring', 'interior_design', 'equipment_dealer', 'real_estate_development',
  'professional_services',
];

describe('catalog', () => {
  it('publishes the 12 v1 packs', () => {
    expect([...CATALOG_KEYS].sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(Object.keys(latestVersions()).length).toBe(12);
    expect(listPacks().map((p) => p.key)).toEqual([...CATALOG_KEYS]);
  });

  it('every pack except general extends general', () => {
    for (const key of CATALOG_KEYS) {
      const m = resolveManifest(key);
      expect(m.extends ?? null).toBe(key === 'general' ? null : 'general');
    }
  });

  it('getPack returns undefined for unknown keys and versions', () => {
    expect(getPack('nope')).toBeUndefined();
    expect(getPack('flooring', '9.9.9')).toBeUndefined();
    expect(getPack('flooring', '1.0.0')?.key).toBe('flooring');
  });
});

describe.each(EXPECTED_KEYS)('pack %s', (key) => {
  const input = resolveManifestInput(key);
  const result = validateManifest(input);

  it('passes validateManifest', () => {
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('meets the catalog authoring standard', () => {
    const m = resolveManifest(key);
    expect(m.keywords.length).toBeGreaterThanOrEqual(10);
    expect(m.keywords.length).toBeLessThanOrEqual(25);
    expect(m.jobTypes.length).toBeGreaterThanOrEqual(2);
    expect(m.jobTypes.length).toBeLessThanOrEqual(5);
    expect(m.stageMachines.length).toBeGreaterThanOrEqual(1);
    expect(m.stageMachines.length).toBeLessThanOrEqual(3);
    for (const sm of m.stageMachines) {
      expect(sm.stages.length, sm.key).toBeGreaterThanOrEqual(5);
      expect(sm.stages.length, sm.key).toBeLessThanOrEqual(9);
    }
    expect(m.costCodes.length).toBeGreaterThanOrEqual(15);
    expect(m.costCodes.length).toBeLessThanOrEqual(60);
    expect(m.kpis.length).toBeGreaterThanOrEqual(4);
    expect(m.kpis.length).toBeLessThanOrEqual(10);
    expect(m.questions.length).toBeGreaterThanOrEqual(2);
    expect(m.questions.length).toBeLessThanOrEqual(5);
    expect(m.sampleJob.tasks.length).toBeGreaterThanOrEqual(3);
    expect(m.sampleJob.tasks.length).toBeLessThanOrEqual(8);
    expect(m.aiProfile.watchFor.length).toBeGreaterThan(0);
    expect(m.approvalPolicies.map((p) => p.key)).toEqual(expect.arrayContaining(['change_order_approval', 'commitment_approval']));
  });

  it('carries no account numbers, only role hints', () => {
    const m = resolveManifest(key);
    const json = JSON.stringify(m);
    expect(json).not.toMatch(/"\w*account\w*":/i); // no account-ish keys
    expect(json).not.toMatch(/\b(gl|account|acct)\.?\s*(no\.?|number|#)?\s*\d{3,}/i);
    for (const c of m.costCodes) {
      expect(c.roleHint).toBeDefined();
      expect(c.code).not.toMatch(/^[1-9]\d{3}$/);
    }
  });

  it('has a sample job with a positive margin', () => {
    const s = resolveManifest(key).sampleJob;
    const budget = s.budget.reduce((n, b) => n + b.amountCents, 0);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(s.contractCents);
  });
});

describe('catalog-wide invariants', () => {
  it('stage machine keys and job type keys are unique across packs (add-ons never collide)', () => {
    const machines = new Map<string, string>();
    const jobTypes = new Map<string, string>();
    for (const key of CATALOG_KEYS) {
      const m = resolveManifest(key);
      for (const sm of m.stageMachines) {
        expect(machines.get(sm.key), `${sm.key} in ${key} and ${machines.get(sm.key)}`).toBeUndefined();
        machines.set(sm.key, key);
      }
      for (const jt of m.jobTypes) {
        expect(jobTypes.get(jt.key), `${jt.key} in ${key} and ${jobTypes.get(jt.key)}`).toBeUndefined();
        jobTypes.set(jt.key, key);
      }
    }
  });

  it('every metric in the catalog is used by at least one pack', () => {
    const used = new Set(CATALOG_KEYS.flatMap((k) => resolveManifest(k).kpis.map((x) => x.metric)));
    for (const metric of METRICS) expect(used.has(metric.key), metric.key).toBe(true);
    expect(new Set(METRICS.map((x) => x.key)).size).toBe(METRICS.length);
  });

  it('every module is used somewhere and the vocabulary list is complete', () => {
    const used = new Set<string>();
    for (const key of CATALOG_KEYS) {
      const m = resolveManifest(key);
      for (const [k, v] of Object.entries(m.modules)) if (v) used.add(k);
      for (const jt of m.jobTypes) for (const [k, v] of Object.entries(jt.modules ?? {})) if (v) used.add(k);
    }
    for (const mod of MODULES) expect(used.has(mod), mod).toBe(true);
    expect(VOCAB_KEYS.length).toBeGreaterThan(20);
  });

  it('published manifests are frozen data (no functions, JSON round-trip safe)', () => {
    for (const m of PACK_MANIFESTS) expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});

describe('extends merge semantics', () => {
  const child: PackManifestInput = {
    ...getPackInput('flooring')!,
    key: 'test_child',
    approvalPolicies: [
      { key: 'commitment_approval', label: 'Override', tiers: [{ maxCents: null, roles: ['owner'], count: 1 }] },
      { key: 'extra_policy', label: 'Extra', tiers: [{ maxCents: null, roles: ['owner'], count: 1 }] },
    ],
    fieldDefs: [{ object: 'project', key: 'only_here', label: 'Only here', type: 'text' }],
    vocabulary: { job: 'Order', jobs: 'Orders' },
    modules: { time: false },
    params: {},
    aiProfile: undefined,
  };
  delete (child as { aiProfile?: unknown }).aiProfile;
  const merged = resolveInput(child);

  it('merges approval policies and field defs by key, parent first', () => {
    expect(merged.approvalPolicies!.map((p) => p.key)).toEqual(['change_order_approval', 'commitment_approval', 'extra_policy']);
    expect(merged.approvalPolicies!.find((p) => p.key === 'commitment_approval')!.label).toBe('Override');
    expect(merged.fieldDefs!.map((f) => f.key)).toEqual(['customer_reference', 'only_here']);
  });

  it('shallow-merges records and inherits omitted ones', () => {
    expect(merged.modules.time).toBe(false);
    expect(merged.modules.estimates).toBe(true); // from general
    expect(merged.params).toEqual({ uses_retainage: { type: 'bool', default: false, label: 'Retainage held on progress billing' } });
    expect(merged.aiProfile?.tone).toBe('plain, direct, numbers first');
  });

  it('replaces the workspace shape and never inherits classifier inputs', () => {
    expect(merged.jobTypes.map((j) => j.key)).toEqual(['retail_install', 'builder_lot', 'commercial_flooring']);
    expect(merged.keywords).toBe(child.keywords);
    const noNaics = resolveInput({ ...child, naics: undefined });
    expect(noNaics.naics).toBeUndefined();
  });

  it('detects extends cycles', () => {
    const a = { ...child, key: 'cyc_a', extends: 'cyc_b' };
    const b = { ...child, key: 'cyc_b', extends: 'cyc_a' };
    const lookup = (k: string) => (k === 'cyc_a' ? a : k === 'cyc_b' ? b : undefined);
    expect(() => resolveInput(a, lookup)).toThrow(/cycle/);
  });
});

describe('validateManifest catches broken manifests', () => {
  const base = resolveManifestInput('residential_remodel');
  const clone = (): PackManifestInput => JSON.parse(JSON.stringify(base));
  const messages = (input: unknown) => {
    const r = validateManifest(input);
    return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
  };

  it('unreachable stage and missing terminal', () => {
    const m = clone();
    const sm = m.stageMachines[0];
    sm.stages.push({ key: 'orphan', label: 'Orphan', coreStatus: 'ACTIVE' });
    expect(messages(m).join('\n')).toMatch(/"orphan" is not reachable/);
  });

  it('transition to an unknown stage, unknown guard and unknown approval policy', () => {
    const m = clone();
    m.stageMachines[0].transitions.push({ from: 'lead', to: 'nowhere', approval: 'no_such_policy' });
    const msgs = messages(m).join('\n');
    expect(msgs).toMatch(/unknown stage "nowhere"/);
    expect(msgs).toMatch(/Unknown approval policy "no_such_policy"/);
    const g = clone();
    (g.stageMachines[0].transitions[0] as { guards: string[] }).guards = ['is_tuesday'];
    expect(messages(g).length).toBeGreaterThan(0);
  });

  it('job type pointing at a missing machine or with a default billing mode it does not allow', () => {
    const m = clone();
    m.jobTypes[0].stageMachine = 'missing_machine';
    m.jobTypes[1].defaultBillingMode = 'SOV';
    const msgs = messages(m).join('\n');
    expect(msgs).toMatch(/Unknown stage machine "missing_machine"/);
    expect(msgs).toMatch(/Default SOV is not an allowed billing mode/);
  });

  it('cost code parents, sample job codes, module and vocab keys', () => {
    const m = clone();
    m.costCodes.push({ code: '99-100', name: 'Orphan', costType: 'OTHER', parent: '99-000' });
    m.sampleJob.budget.push({ code: 'NOPE', amountCents: 1 });
    m.modules.teleportation = true;
    (m.vocabulary as Record<string, string>).spaceship = 'Rocket';
    const msgs = messages(m).join('\n');
    expect(msgs).toMatch(/Parent "99-000" does not exist/);
    expect(msgs).toMatch(/Unknown cost code "NOPE"/);
    expect(msgs).toMatch(/Unknown module "teleportation"/);
    expect(msgs).toMatch(/Unknown vocabulary key "spaceship"/);
  });

  it('question effects must reference real modules, params and job types', () => {
    const m = clone();
    m.questions![0].effects = [{ kind: 'enable_job_types', jobTypes: ['ghost_type'] }];
    m.questions![1].effects = [{ kind: 'set_param', param: 'ghost_param' }];
    const msgs = messages(m).join('\n');
    expect(msgs).toMatch(/Unknown job type "ghost_type"/);
    expect(msgs).toMatch(/Unknown param "ghost_param"/);
    const t = clone();
    t.questions!.push({ key: 'bad_toggle', prompt: 'x', answer: { type: 'bool', default: true }, effects: [{ kind: 'toggle_module', module: 'warp_drive' as never }] });
    expect(messages(t).length).toBeGreaterThan(0);
  });

  it('rejects account numbers anywhere', () => {
    const m = clone();
    (m.costCodes[1] as Record<string, unknown>).glAccount = '5100';
    expect(messages(m).join('\n')).toMatch(/account/i);
    const n = clone();
    n.costCodes[1].name = 'Labor to account 5100';
    expect(messages(n).join('\n')).toMatch(/account number/);
    const o = clone();
    o.jobTypes[0].description = '1180';
    expect(messages(o).join('\n')).toMatch(/looks like an account number/);
    const p = clone();
    p.costCodes.push({ code: '5100', name: 'Looks like a GL account', costType: 'OTHER' });
    expect(messages(p).join('\n')).toMatch(/looks like a GL account number/);
    const q = clone();
    (q.costCodes[1] as Record<string, unknown>).roleHint = 'COST_5100';
    expect(messages(q).length).toBeGreaterThan(0);
  });

  it('KPIs must use catalog metrics with the catalog direction', () => {
    const m = clone();
    m.kpis![0] = { key: 'vibes', label: 'Vibes', metric: 'vibes_index', goodDirection: 'up' };
    m.kpis![1] = { ...m.kpis![1], goodDirection: m.kpis![1].goodDirection === 'up' ? 'down' : 'up' };
    const msgs = messages(m).join('\n');
    expect(msgs).toMatch(/Unknown metric "vibes_index"/);
    expect(msgs).toMatch(/is good when/);
  });

  it('banned copy words', () => {
    const m = clone();
    m.tagline = 'World-class solutions for your portfolio';
    expect(messages(m).join('\n')).toMatch(/banned word/);
  });
});
