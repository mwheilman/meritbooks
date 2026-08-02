import { describe, it, expect } from 'vitest';
import {
  parseClassifierOutput,
  resolveMetric,
  abstainMessage,
  buildClassifierPrompt,
  METRICS,
  METRIC_IDS,
} from './metric-catalog';

// Pure-part unit tests only — no DB resolvers (no Supabase in the unit env).
// The safety kernel we assert here is what makes the lane injection-safe:
// parsing tolerates messy model output, and resolveMetric fails CLOSED to
// abstain on anything not exactly an allowlisted metric with valid params.

describe('parseClassifierOutput', () => {
  it('parses clean JSON', () => {
    const out = parseClassifierOutput('{"metric":"portfolio_margin","params":{}}');
    expect(out).toEqual({ metric: 'portfolio_margin', params: {} });
  });

  it('parses fenced ```json JSON', () => {
    const text = '```json\n{"metric":"jobs_at_risk","params":{"margin_pct":0.12}}\n```';
    const out = parseClassifierOutput(text);
    expect(out).toEqual({ metric: 'jobs_at_risk', params: { margin_pct: 0.12 } });
  });

  it('parses JSON wrapped in surrounding prose', () => {
    const text = 'Sure! Here is the routing:\n{"metric":"job_lookup","params":{"job_name":"Ridgeline"}} — hope that helps.';
    const out = parseClassifierOutput(text);
    expect(out).toEqual({ metric: 'job_lookup', params: { job_name: 'Ridgeline' } });
  });

  it('returns null on non-JSON garbage', () => {
    expect(parseClassifierOutput('I cannot help with that.')).toBeNull();
  });

  it('returns null when JSON has no metric key', () => {
    expect(parseClassifierOutput('{"params":{}}')).toBeNull();
  });

  it('defaults params to {} when the model omits/malforms them', () => {
    expect(parseClassifierOutput('{"metric":"portfolio_margin"}')).toEqual({
      metric: 'portfolio_margin',
      params: {},
    });
    expect(parseClassifierOutput('{"metric":"portfolio_margin","params":[1,2]}')).toEqual({
      metric: 'portfolio_margin',
      params: {},
    });
  });
});

describe('resolveMetric', () => {
  it('accepts a valid metric with empty params', () => {
    const r = resolveMetric({ metric: 'portfolio_margin', params: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.id).toBe('portfolio_margin');
  });

  it('accepts jobs_at_risk with a valid margin_pct fraction', () => {
    const r = resolveMetric({ metric: 'jobs_at_risk', params: { margin_pct: 0.15 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params).toEqual({ margin_pct: 0.15 });
  });

  it('abstains on the sentinel "none"', () => {
    const r = resolveMetric({ metric: 'none', params: {} });
    expect(r.ok).toBe(false);
  });

  it('abstains on an unknown metric id (injection attempt)', () => {
    const r = resolveMetric({ metric: "'; drop table proj.jobs; --", params: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('unknown metric');
  });

  it('abstains on out-of-range params (margin_pct must be 0..1)', () => {
    const r = resolveMetric({ metric: 'jobs_at_risk', params: { margin_pct: 12 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('validation');
  });

  it('abstains when job_lookup is missing its REQUIRED job_name', () => {
    const r = resolveMetric({ metric: 'job_lookup', params: {} });
    expect(r.ok).toBe(false);
  });

  it('accepts job_lookup with a job_name', () => {
    const r = resolveMetric({ metric: 'job_lookup', params: { job_name: 'Ridgeline' } });
    expect(r.ok).toBe(true);
  });

  it('abstains on a null choice (unparseable classification)', () => {
    const r = resolveMetric(null);
    expect(r.ok).toBe(false);
  });
});

describe('metric allowlist completeness', () => {
  it('exposes the 8 expected portfolio metrics', () => {
    expect(METRIC_IDS.sort()).toEqual(
      [
        'billing_status',
        'commitment_exposure',
        'gates_blocking_billing',
        'job_lookup',
        'jobs_at_risk',
        'over_budget_cost_codes',
        'portfolio_margin',
        'retainage_outstanding',
      ].sort(),
    );
  });

  it('every metric has an id/description/paramHint/example/schema/resolver', () => {
    for (const id of METRIC_IDS) {
      const m = METRICS[id];
      expect(m.id).toBe(id);
      expect(typeof m.description).toBe('string');
      expect(m.description.length).toBeGreaterThan(0);
      expect(typeof m.paramHint).toBe('string');
      expect(typeof m.example).toBe('string');
      expect(typeof m.resolver).toBe('function');
      expect(m.paramsSchema).toBeDefined();
    }
  });

  it('buildClassifierPrompt lists every metric id and embeds the user prompt', () => {
    const prompt = buildClassifierPrompt('how are my jobs doing?');
    for (const id of METRIC_IDS) expect(prompt).toContain(`"${id}"`);
    expect(prompt).toContain('how are my jobs doing?');
    expect(prompt).toContain('none');
  });

  it('abstainMessage lists example questions', () => {
    const msg = abstainMessage();
    expect(msg).toContain('•');
    expect(msg.length).toBeGreaterThan(50);
  });
});
