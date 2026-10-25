import { describe, expect, it } from 'vitest';
import { planHash } from '@meritbooks/industry-packs';
import { applyModuleOverrides, buildApplyPayload, buildPlan, initialAnswers, PlanCompileError, previewPlan } from './plan';
import { ApplySchema } from './schemas';
import type { ClassifyResponse, PlanInputs } from './types';

const LOC = '7a1c6c8e-1d1e-4b8a-9c55-0c3b3f7c9a01';
const DEC = '0b9f2c3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

const base: PlanInputs = { companyId: LOC, packKey: 'field_service', addons: [], answers: {}, moduleOverrides: {} };

const classification: ClassifyResponse = {
  candidates: [{ packKey: 'field_service', name: 'Field service', tileLabel: 'Field service', confidence: 92, reasons: [], source: 'merged' }],
  abstain: false, source: 'merged', ai: { outcome: 'used', message: null }, evidence: ['furnaces and AC'],
  aiPackKey: 'field_service',
  prefilledAnswers: { does_commercial: { value: true, evidence: 'commercial rooftop units' } },
  params: {}, paramsPackKey: 'field_service', decisionId: DEC, rejected: 0,
};

describe('plan request → apply payload', () => {
  it('compiles deterministically and carries the sample job for load_sample_job', () => {
    const a = buildPlan(base);
    const b = buildPlan({ ...base });
    expect(a.plan_hash).toBe(b.plan_hash);
    expect(a.location_id).toBe(LOC);
    expect(a.sample_job).not.toBeNull();
  });

  it('the apply payload is the plan plus the additive ai_decision_id key', () => {
    const plan = buildPlan(base);
    const payload = buildApplyPayload(plan, DEC);
    expect(payload.ai_decision_id).toBe(DEC);
    expect(payload.plan_hash).toBe(plan.plan_hash);
    expect(payload.schema_version).toBe(2); // plan schema v2: adds the experience section
    expect(buildApplyPayload(plan, null)).not.toHaveProperty('ai_decision_id');
  });

  it('the apply body requires the previewed hash', () => {
    const plan = buildPlan(base);
    expect(ApplySchema.safeParse({ ...base, expectedPlanHash: plan.plan_hash, aiDecisionId: DEC }).success).toBe(true);
    expect(ApplySchema.safeParse({ ...base }).success).toBe(false);
  });

  it('answers recompile the plan; bad answers are a PlanCompileError', () => {
    const off = buildPlan({ ...base, answers: { sells_memberships: false } });
    expect(off.job_types.map((j) => j.key)).not.toContain('maintenance_visit');
    expect(() => buildPlan({ ...base, answers: { sells_memberships: 'maybe' } })).toThrow(PlanCompileError);
    expect(() => buildPlan({ ...base, packKey: 'nope' })).toThrow(PlanCompileError);
  });

  it('module switches change modules + hash, are recorded, and are idempotent', () => {
    const plan = buildPlan(base);
    expect(plan.modules.daily_logs).toBe(false);
    const on = buildPlan({ ...base, moduleOverrides: { daily_logs: true } });
    expect(on.modules.daily_logs).toBe(true);
    expect(on.job_types.every((j) => j.modules.daily_logs)).toBe(true);
    expect(on.module_overrides).toEqual({ daily_logs: true });
    expect(on.plan_hash).not.toBe(plan.plan_hash);
    expect(on.plan_hash).toBe(buildPlan({ ...base, moduleOverrides: { daily_logs: true } }).plan_hash);
    const { plan_hash: _h, ...rest } = on;
    expect(planHash(rest)).toBe(on.plan_hash);
    // a switch matching the compiled default is a no-op
    expect(applyModuleOverrides(plan, { dispatch: true }).plan_hash).toBe(plan.plan_hash);
  });

  it('retainage only turns on for progress / pay-app / draw job types', () => {
    const on = buildPlan({ ...base, moduleOverrides: { retainage: true } });
    for (const j of on.job_types) {
      const eligible = j.billing_modes.some((b) => ['SOV', 'PROGRESS_PCT', 'DRAW'].includes(b));
      expect(j.modules.retainage).toBe(eligible);
      if (!eligible) expect(j.default_retainage_pct).toBeNull();
    }
  });

  it('preview: questions prefilled from AI evidence only for the AI pack; diff in change mode', () => {
    const answers = initialAnswers('field_service', classification);
    expect(answers).toEqual({ does_commercial: true });
    expect(initialAnswers('flooring', classification)).toEqual({});
    const plan = buildPlan({ ...base, answers });
    const pv = previewPlan(plan, { ...base, answers }, classification, buildPlan(base));
    const q = pv.questions.find((x) => x.key === 'does_commercial')!;
    expect(q.suggestedFrom).toBe('commercial rooftop units');
    expect(pv.vocabularyHeadline.length).toBeGreaterThan(0);
    expect(pv.costCodes.count).toBe(plan.cost_codes.length);
    expect(pv.diff?.identical).toBe(false);
    expect(pv.diff?.lines.some((l) => l.section === 'Kinds of work')).toBe(true);
    expect(pv.cards.some((c) => c.section === 'sample_job')).toBe(false);
  });

  it('add-on packs merge and namespace their questions', () => {
    const plan = buildPlan({ ...base, packKey: 'residential_remodel', addons: ['field_service'] });
    expect(plan.addon_packs.map((a) => a.key)).toEqual(['field_service']);
    const pv = previewPlan(plan, { ...base, packKey: 'residential_remodel', addons: ['field_service'] }, null, null);
    expect(pv.questions.some((q) => q.key.startsWith('field_service.'))).toBe(true);
  });
});
