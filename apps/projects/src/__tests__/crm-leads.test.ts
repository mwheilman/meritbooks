/**
 * Lead stage transitions, the board, speed to lead, next-step flags and saved filters
 * (panel 06 §2.3/§2d). Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  boardColumns, boardStages, businessDaysBetween, checkMove, dueFollowups, durationWords, enteredStageAt, firstTouchAt, followupState,
  needsNextStep, reasonProblem, speedToLead, stageProbability, weightedCents,
} from '@/lib/crm/stages';
import type { LeadRow, Pipeline, StageRow } from '@/lib/crm/types';
import { DEFAULT_FILTER, PRESET_FILTERS, applyFilter, filterParams, parseFilter, parseSaved, sameFilter, type LeadView } from '@/lib/crm/view';
import { NewLeadBody, UpdateLeadBody, leadCustomerName, leadHasPerson, leadPatch } from '@/lib/crm/schemas';
import { completeFollowupArgs, convertLeadArgs, createLeadArgs, moveLeadArgs, parseConvertResult } from '@/lib/crm/contract';

const P = 'p0000000-0000-4000-8000-000000000001';
const st = (id: string, kind: StageRow['kind'], sort: number, prob: number | null = null): StageRow => ({ id, pipeline_id: P, key: id, name: id.toUpperCase(), kind, probability_pct: prob, sort });
const NEW = st('new', 'open', 1, 10);
const PROP = st('proposal', 'open', 3, 50);
const CONSULT = st('consult', 'open', 2, 25);
const WON = st('won', 'won', 9);
const LOST = st('lost', 'lost', 10);
const pipe: Pipeline = { id: P, org_id: 'o', location_id: 'l', key: 'remodel', name: 'Remodel sales', pack_key: 'residential_remodel', is_default: true, stages: [LOST, PROP, WON, NEW, CONSULT] };

const lead = (over: Partial<LeadRow> = {}): LeadRow => ({
  id: 'lead1', org_id: 'o', location_id: 'l', pipeline_id: P, stage_id: NEW.id, title: 'Kitchen', customer_id: null, contact_id: null, site_id: null,
  source: 'web_form', source_detail: null, campaign: null, owner_membership_id: null, estimated_value_cents: 8_000_000, expected_close_on: null,
  next_step: null, next_step_on: null, lost_reason: null, won_at: null, lost_at: null, converted_estimate_id: null, converted_job_id: null,
  created_by: null, created_at: '2026-10-20T14:00:00Z', updated_at: '2026-10-20T14:00:00Z', ...over,
});

describe('checkMove (stage transition rules)', () => {
  it('open → open moves with no reason', () => {
    expect(checkMove(lead(), NEW, PROP)).toEqual({ ok: true, reason: null });
  });
  it('the same stage is refused', () => {
    expect(checkMove(lead(), NEW, NEW).ok).toBe(false);
  });
  it('Lost needs a reason', () => {
    expect(checkMove(lead(), PROP, LOST)).toEqual({ ok: true, reason: 'lost' });
    expect(reasonProblem('lost', '')).toMatch(/why it was lost/);
    expect(reasonProblem('lost', 'Price')).toBeNull();
  });
  it('Won needs a customer or contact to have won it from', () => {
    const r = checkMove(lead(), PROP, WON);
    expect(r.ok).toBe(false);
    expect(checkMove(lead({ customer_id: 'c1' }), PROP, WON)).toEqual({ ok: true, reason: null });
    expect(checkMove(lead({ contact_id: 'k1' }), PROP, WON).ok).toBe(true);
  });
  it('reopening a won or lost lead needs a reason', () => {
    expect(checkMove(lead({ customer_id: 'c' }), LOST, NEW)).toEqual({ ok: true, reason: 'reopen' });
    expect(checkMove(lead({ customer_id: 'c' }), WON, PROP)).toEqual({ ok: true, reason: 'reopen' });
    expect(reasonProblem('reopen', 'no')).toMatch(/open again/);
    expect(reasonProblem(null, null)).toBeNull();
  });
  it('a lead that became a job stays won', () => {
    const r = checkMove(lead({ customer_id: 'c', converted_job_id: 'j' }), WON, LOST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/became a job/);
  });
  it('a lead converted to an estimate is locked too (crm.move_lead refuses it)', () => {
    expect(checkMove(lead({ customer_id: 'c', converted_estimate_id: 'e' }), WON, PROP).ok).toBe(false);
  });
  it('convert and follow-up argument shapes', () => {
    expect(convertLeadArgs('l', 'estimate', null)).toEqual({ p_lead: 'l', p_target: 'estimate', p_job_type_key: null });
    expect(completeFollowupArgs('f')).toEqual({ p_followup: 'f', p_outcome: null });
    expect(parseConvertResult({ lead_id: 'l', target: 'job', customer_id: 'c', customer_created: true, job_id: 'j', estimate_id: null }))
      .toEqual({ estimateId: null, jobId: 'j', customerId: 'c', customerCreated: true });
    expect(parseConvertResult(null)).toEqual({ estimateId: null, jobId: null, customerId: null, customerCreated: false });
  });
  it('a stage from another pipeline is refused', () => {
    expect(checkMove(lead(), NEW, { ...PROP, pipeline_id: 'other' }).ok).toBe(false);
  });
  it('maps to crm.move_lead(p_lead, p_stage, p_reason)', () => {
    expect(moveLeadArgs('l', 's', 'Price')).toEqual({ p_lead: 'l', p_stage: 's', p_reason: 'Price' });
  });
});

describe('the board', () => {
  it('orders open stages by sort, then won, then lost', () => {
    expect(boardStages(pipe.stages).map((s) => s.id)).toEqual(['new', 'consult', 'proposal', 'won', 'lost']);
  });
  it('weights value by stage probability (won 100%, lost 0%)', () => {
    expect(stageProbability(PROP)).toBe(0.5);
    expect(stageProbability(WON)).toBe(1);
    expect(stageProbability(LOST)).toBe(0);
    expect(stageProbability({ kind: 'open', probability_pct: 250 })).toBe(1);
    expect(weightedCents(lead(), PROP)).toBe(4_000_000);
  });
  it('columns total their leads', () => {
    const cols = boardColumns(pipe, [lead({ id: 'a', stage_id: PROP.id }), lead({ id: 'b', stage_id: PROP.id, estimated_value_cents: null })]);
    const prop = cols.find((c) => c.stage.id === PROP.id)!;
    expect(prop.leads).toHaveLength(2);
    expect(prop.valueCents).toBe(8_000_000);
    expect(prop.weightedCents).toBe(4_000_000);
  });
  it('days in stage count from the last move into it', () => {
    expect(enteredStageAt(lead({ stage_id: PROP.id }), [{ to_stage_id: PROP.id, created_at: '2026-10-21T00:00:00Z' }, { to_stage_id: PROP.id, created_at: '2026-10-22T00:00:00Z' }, { to_stage_id: NEW.id, created_at: '2026-10-23T00:00:00Z' }])).toBe('2026-10-22T00:00:00Z');
    expect(enteredStageAt(lead(), [])).toBe(lead().created_at);
  });
});

describe('speed to lead', () => {
  const at = (iso: string) => Date.parse(iso);
  it('first touch = earliest outbound contact activity (notes and inbound do not count)', () => {
    expect(firstTouchAt([
      { kind: 'note', direction: null, occurred_at: '2026-10-20T14:01:00Z' },
      { kind: 'call', direction: 'inbound', occurred_at: '2026-10-20T14:02:00Z' },
      { kind: 'sms', direction: 'outbound', occurred_at: '2026-10-20T14:04:00Z' },
      { kind: 'call', direction: null, occurred_at: '2026-10-20T14:10:00Z' },
    ])).toBe('2026-10-20T14:04:00Z');
    expect(firstTouchAt([{ kind: 'note', direction: null, occurred_at: '2026-10-20T14:01:00Z' }])).toBeNull();
  });
  it('answered within 5 minutes is on target', () => {
    const s = speedToLead('2026-10-20T14:00:00Z', '2026-10-20T14:04:00Z', true, at('2026-10-21T00:00:00Z'))!;
    expect(s).toMatchObject({ state: 'answered', tone: 'ready' });
    expect(s.text).toBe('First touch in 4 min');
  });
  it('waiting grows track → risk → overdue', () => {
    expect(speedToLead('2026-10-20T14:00:00Z', null, true, at('2026-10-20T14:03:00Z'))!.tone).toBe('track');
    expect(speedToLead('2026-10-20T14:00:00Z', null, true, at('2026-10-20T14:30:00Z'))!.tone).toBe('risk');
    const late = speedToLead('2026-10-20T14:00:00Z', null, true, at('2026-10-20T16:10:00Z'))!;
    expect(late).toMatchObject({ state: 'waiting', tone: 'overdue', text: 'Waiting 2 h 10 min' });
  });
  it('a closed lead nobody touched has no timer', () => {
    expect(speedToLead('2026-10-20T14:00:00Z', null, false, at('2026-10-22T00:00:00Z'))).toBeNull();
  });
  it('durations read plainly', () => {
    expect(durationWords(0.2)).toBe('under a minute');
    expect(durationWords(60)).toBe('1 h');
    expect(durationWords(60 * 72)).toBe('3 days');
  });
});

describe('next step and follow-ups', () => {
  it('counts weekdays only', () => {
    expect(businessDaysBetween('2026-10-23', '2026-10-26')).toBe(1); // Fri → Mon
    expect(businessDaysBetween('2026-10-20', '2026-10-22')).toBe(2);
  });
  it('flags an open lead with no next step after 2 business days', () => {
    expect(needsNextStep(lead({ created_at: '2026-10-20T10:00:00Z' }), true, null, '2026-10-21')).toBe(false);
    expect(needsNextStep(lead({ created_at: '2026-10-20T10:00:00Z' }), true, null, '2026-10-22')).toBe(true);
    expect(needsNextStep(lead({ next_step: 'Call', next_step_on: '2026-10-30' }), true, null, '2026-10-29')).toBe(false);
    expect(needsNextStep(lead({ next_step: 'Call', next_step_on: '2026-10-21', created_at: '2026-10-21T10:00:00Z' }), true, null, '2026-10-22')).toBe(true);
    expect(needsNextStep(lead({ created_at: '2026-10-01T10:00:00Z' }), false, null, '2026-10-22')).toBe(false);
  });
  it('follow-up states', () => {
    expect(followupState({ due_on: '2026-10-20', done_at: null }, '2026-10-21')).toBe('overdue');
    expect(followupState({ due_on: '2026-10-21', done_at: null }, '2026-10-21')).toBe('due');
    expect(followupState({ due_on: '2026-10-22', done_at: null }, '2026-10-21')).toBe('upcoming');
    expect(followupState({ due_on: '2026-10-20', done_at: '2026-10-20T10:00:00Z' }, '2026-10-21')).toBe('done');
    expect(dueFollowups([{ due_on: '2026-10-22', done_at: null }, { due_on: '2026-10-19', done_at: null }, { due_on: '2026-10-18', done_at: 'x' }], '2026-10-21')).toEqual([{ due_on: '2026-10-19', done_at: null }]);
  });
});

describe('saved filters', () => {
  const v = (over: Partial<LeadView>): LeadView => ({
    id: 'x', title: 'Kitchen', companyId: 'l', company: null, pipelineId: P, stageId: NEW.id, stageName: 'New', stageKind: 'open', probability: 0.1,
    customerId: null, customerName: 'Harbor', contactName: null, site: '12 Elm St', source: 'web_form', sourceLabel: 'Web form', campaign: null,
    ownerId: 'me', ownerName: 'Me', amountCents: null, nextStep: null, nextStepOn: null, expectedCloseOn: null, daysInStage: 0, speed: null,
    followupsDue: 0, followupsOverdue: 0, needsNextStep: false, lostReason: null, convertedJobId: null, convertedEstimateId: null,
    createdAt: '', updatedAt: '', closedAt: null, ...over,
  });
  const rows = [
    v({ id: 'a' }),
    v({ id: 'b', ownerId: null, ownerName: null, source: 'referral', sourceLabel: 'Referral', followupsDue: 2 }),
    v({ id: 'c', stageKind: 'won' }),
    v({ id: 'd', speed: { state: 'waiting', minutes: 90, tone: 'overdue', text: '' }, needsNextStep: true, title: 'Bath' }),
  ];
  const ids = (f = DEFAULT_FILTER) => applyFilter(rows, f, 'me').map((r) => r.id);
  it('presets', () => {
    const p = (id: string) => PRESET_FILTERS.find((x) => x.id === id)!.filter;
    expect(ids()).toEqual(['a', 'b', 'd']);
    expect(ids(p('mine'))).toEqual(['a', 'd']);
    expect(ids(p('unassigned'))).toEqual(['b']);
    expect(ids(p('untouched'))).toEqual(['d']);
    expect(ids(p('followups'))).toEqual(['b']);
    expect(ids(p('no_next_step'))).toEqual(['d']);
    expect(ids(p('won'))).toEqual(['c']);
  });
  it('search and source', () => {
    expect(ids({ ...DEFAULT_FILTER, q: 'elm' })).toEqual(['a', 'b', 'd']);
    expect(ids({ ...DEFAULT_FILTER, q: 'bath' })).toEqual(['d']);
    expect(ids({ ...DEFAULT_FILTER, source: 'referral' })).toEqual(['b']);
  });
  it('round-trips through the URL, unknown values fall back', () => {
    const f = { ...DEFAULT_FILTER, owner: 'me' as const, flag: 'followups' as const, q: 'kitchen' };
    const p = new URLSearchParams(filterParams(f));
    expect(sameFilter(parseFilter(p), f)).toBe(true);
    expect(parseFilter(new URLSearchParams('owner=boss&state=gone'))).toEqual(DEFAULT_FILTER);
    expect(filterParams(DEFAULT_FILTER)).toEqual({});
  });
  it('viewer-saved filters are validated on read', () => {
    expect(parseSaved('not json')).toEqual([]);
    expect(parseSaved(JSON.stringify([{ id: 'f1', label: 'Mine', filter: { owner: 'me', state: 'bogus' } }, { nope: 1 }]))).toEqual([
      { id: 'f1', label: 'Mine', filter: { ...DEFAULT_FILTER, owner: 'me' } },
    ]);
  });
});

describe('the new-lead door', () => {
  const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  it('needs a company and a title; the person and money are optional', () => {
    expect(NewLeadBody.safeParse({ companyId: C, title: '' }).success).toBe(false);
    const ok = NewLeadBody.parse({ companyId: C, title: 'Kitchen', valueCents: '8000000' });
    expect(ok.valueCents).toBe(8_000_000);
    expect(ok.customer).toBeNull();
  });
  it('a household is named for the person', () => {
    const c = NewLeadBody.parse({ companyId: C, title: 'K', customer: { firstName: 'Dana', lastName: 'Lee', email: 'dana@x.com' } }).customer!;
    expect(leadHasPerson(c)).toBe(true);
    expect(leadCustomerName(c)).toBe('Dana Lee');
    expect(c.match).toEqual({ useId: null, newReason: null });
    expect(leadHasPerson(NewLeadBody.parse({ companyId: C, title: 'K', customer: {} }).customer)).toBe(false);
  });
  it('edits map to crm.leads columns, only the keys sent', () => {
    expect(leadPatch(UpdateLeadBody.parse({ nextStep: 'Call', valueCents: 100 }))).toEqual({ next_step: 'Call', estimated_value_cents: 100 });
    expect(leadPatch(UpdateLeadBody.parse({}))).toEqual({});
  });
  it('maps to crm.create_lead with the house p_ prefix', () => {
    const a = createLeadArgs({ companyId: C, title: 'K', pipelineId: null, stageId: null, customerId: null, contactId: null, siteId: null, source: 'web_form', sourceDetail: null, campaign: null, ownerMembershipId: null, valueCents: 5, expectedCloseOn: null, nextStep: null, nextStepOn: null });
    expect(Object.keys(a).every((k) => k.startsWith('p_'))).toBe(true);
    expect(a).toMatchObject({ p_location: C, p_title: 'K', p_estimated_value_cents: 5 });
  });
});
