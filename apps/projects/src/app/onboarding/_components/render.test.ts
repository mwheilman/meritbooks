/**
 * SSR smoke test: every onboarding step renders with a real compiled plan (no throws, no
 * banned copy). Uses createElement because the suite only collects *.test.ts.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildPlan, previewPlan } from '@/lib/onboarding/plan';
import { packTiles } from '@/lib/onboarding/load';
import type { ClassifyResponse, CompanyBrief, ParseResponse, PlanInputs } from '@/lib/onboarding/types';
import { DescribeStep } from './describe-step';
import { WorkspaceStep } from './workspace-step';
import { BringStep } from './bring-step';
import { TeamStep } from './team-step';
import { SelectStep } from './select-step';
import { ImportReview } from './import-review';
import type { CompanyFlow } from './flow';

// vitest compiles .tsx with the classic runtime (tsconfig jsx: preserve); Next uses the automatic one.
(globalThis as { React?: typeof React }).React = React;

const LOC = '7a1c6c8e-1d1e-4b8a-9c55-0c3b3f7c9a01';
const BANNED = /\b(portfolio|synergy|leverage|world[- ]class|revolutioni[sz]e|solutions|no data)\b/i;
const ref = { current: null };
const noop = () => {};

const company: CompanyBrief = {
  id: LOC, name: 'Heartland Heating & Cooling', shortCode: 'HHC', industry: 'HVAC', revRecMethod: 'POINT_OF_SALE',
  jobCount: 3, unadoptedJobCount: 3, installed: null, run: null,
  booksGuess: { packKey: 'field_service', label: 'Field service', confidence: 70, reasons: ['"HVAC" in the company industry in Books'] },
  preselect: { selected: true, reasons: ['3 jobs already in Merit Books'] },
};

const cls: ClassifyResponse = {
  candidates: [
    { packKey: 'field_service', name: 'Field service', tileLabel: 'Field service', confidence: 91, reasons: ['You wrote "furnaces and AC"'], source: 'merged' },
    { packKey: 'specialty_trade', name: 'Specialty trade', tileLabel: 'Specialty trade', confidence: 40, reasons: ['"tech"'], source: 'rules' },
  ],
  abstain: false, source: 'merged', ai: { outcome: 'unavailable', message: 'paused' }, evidence: ['furnaces and AC', '12 trucks'],
  aiPackKey: 'field_service', prefilledAnswers: { does_commercial: { value: true, evidence: 'commercial rooftop units' } },
  params: {}, paramsPackKey: null, decisionId: null, rejected: 2,
};

const inputs: PlanInputs = { companyId: LOC, packKey: 'field_service', addons: [], answers: { does_commercial: true }, moduleOverrides: { daily_logs: true } };
const plan = buildPlan(inputs);
const preview = previewPlan(plan, inputs, cls, null);

const flow: CompanyFlow = {
  step: 'preview', description: 'We install and service furnaces and AC, 12 trucks', tile: null, file: null,
  classification: cls, plan: inputs, preview,
  jobTypes: preview.jobTypes.map((j) => ({ key: j.key, label: j.label, archetype: j.archetype })),
  sampleJobId: null, firstJobId: null,
};

const file: ParseResponse = {
  fileName: 'jobs.csv', vendor: 'Buildertrend', headers: ['Job Name', 'Owner Name', 'Contract Price', 'Job Status'], headerRow: 1,
  rowCount: 2, truncated: false,
  mapping: { name: { header: 'Job Name', confidence: 0.95, source: 'alias' }, customer: { header: 'Owner Name', confidence: 0.95, source: 'alias' }, contract: { header: 'Contract Price', confidence: 0.65, source: 'fuzzy' }, status: { header: 'Job Status', confidence: 0.95, source: 'alias' } },
  unmappedHeaders: [], ai: { outcome: 'skipped', message: null, mapped: 0 },
  records: [{ 'Job Name': 'Okafor heat pump', 'Owner Name': 'Grace Okafor', 'Contract Price': '$14,850.00', 'Job Status': 'Open' }, { 'Job Name': 'Lee furnace', 'Owner Name': 'Lee', 'Contract Price': '6200', 'Job Status': 'Closed' }],
  rowNumbers: [2, 3], aiDecisionId: null,
};

function ok(html: string) {
  expect(html.length).toBeGreaterThan(200);
  expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(BANNED);
  return html;
}

describe('onboarding steps render', () => {
  it('select', () => {
    ok(renderToString(h(SelectStep, { companies: [company, { ...company, id: 'b', name: 'Clive Power Equipment', preselect: { selected: false, reasons: [] } }], busy: false, error: null, onConfirm: noop, primaryRef: ref })));
  });
  it('describe (with Books guess and tiles)', () => {
    const html = ok(renderToString(h(DescribeStep, {
      company, tiles: packTiles(), flow: { ...flow, step: 'describe', classification: null }, mode: 'first', aiConfigured: true, busy: null, error: null,
      onChange: noop, onFile: noop, onSubmit: noop, onPick: noop, onBack: null, primaryRef: ref,
    })));
    expect(html).toContain('What kind of work does Heartland Heating &amp; Cooling do?');
    expect(html.match(/class="ob-tile"/g)?.length).toBe(12);
  });
  it('describe (abstain + AI paused)', () => {
    ok(renderToString(h(DescribeStep, {
      company, tiles: packTiles(), flow: { ...flow, step: 'describe', classification: { ...cls, abstain: true } }, mode: 'first', aiConfigured: true, busy: null, error: 'x',
      onChange: noop, onFile: noop, onSubmit: noop, onPick: noop, onBack: noop, primaryRef: ref,
    })));
  });
  it('workspace (note, evidence that ties, cards, questions, switches)', () => {
    const html = ok(renderToString(h(WorkspaceStep, { company, flow, mode: 'first', busy: null, error: null, onInputs: noop, onPick: noop, onApply: noop, onBack: noop, primaryRef: ref })));
    expect(html).toContain('furnaces and AC');
    expect(html).toContain('Suggested from your description');
    expect(html).toContain('AI assist paused');
    expect(html).toContain('Set up Heartland');
  });
  it('workspace loading and change-mode diff', () => {
    ok(renderToString(h(WorkspaceStep, { company, flow: { ...flow, preview: null }, mode: 'first', busy: 'plan', error: null, onInputs: noop, onPick: noop, onApply: noop, onBack: noop, primaryRef: ref })) + 'x'.repeat(200));
    const changed = previewPlan(plan, inputs, cls, buildPlan({ ...inputs, answers: {}, moduleOverrides: {} }));
    const html = ok(renderToString(h(WorkspaceStep, { company, flow: { ...flow, preview: changed }, mode: 'change', busy: null, error: null, onInputs: noop, onPick: noop, onApply: noop, onBack: noop, primaryRef: ref })));
    expect(html).toContain('Nothing is deleted');
  });
  it('bring work and import review', () => {
    ok(renderToString(h(BringStep, { company, flow: { ...flow, step: 'bring_work', file }, onPatch: noop, onContinue: noop, primaryRef: ref })));
    const html = ok(renderToString(h(ImportReview, { companyId: LOC, file, jobTypes: flow.jobTypes, onDone: noop, onCancel: noop })));
    expect(html).toContain('14,850.00');
    expect(html).toContain('1 finished or cancelled left out');
  });
  it('team (empty and listed)', () => {
    ok(renderToString(h(TeamStep, { company, team: [], booksTeamUrl: 'https://books/team', busy: false, error: null, onFinish: noop, onBack: noop, primaryRef: ref })));
    ok(renderToString(h(TeamStep, { company, team: [{ id: '1', name: 'Dana Lee', title: 'PM', email: 'd@x.co', role: 'business_user' }], booksTeamUrl: 'https://books/team', busy: false, error: null, onFinish: noop, onBack: noop, primaryRef: ref })));
  });
});
