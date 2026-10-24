/**
 * AC-3E.6 — AI draft: the fact sheet, the traceability verifier (every $ / % / citation
 * must tie to the ledger facts), and the AI-down fallback (no key, provider disabled,
 * budget blocked) that leaves the person with the deterministic driver summary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const runAiGateway = vi.fn();
vi.mock('@meritbooks/core-ai', () => ({ runAiGateway: (...a: unknown[]) => runAiGateway(...a) }));

import { buildFactSheet, draftFluxExplanation, driverSummary, parseDraftReply, verifyDraft } from './ai-draft';
import type { FluxDrivers, FluxLine } from './types';

const LINE: FluxLine = {
  lineKey: 'repairs', accountId: 'repairs', accountNumber: '6300', accountName: 'Repairs & maintenance', accountType: 'OPEX',
  groupName: null, statement: 'PNL', departmentId: null, classId: null, dimensionLabel: null,
  currentCents: 1_500_000, comparisonCents: 200_000, changeCents: 1_300_000, changePctBps: 65_000, basisUsed: 'PRIOR_MONTH',
  threshold: { mode: 'EITHER', absThresholdCents: 500_000, pctThresholdBps: 1_000, excluded: false, source: 'Policy' },
  material: true, breaches: ['ABS', 'PCT'], trailing: [],
};
const DRIVERS: FluxDrivers = {
  lines: [
    { ref: 'L1', glEntryId: 'e1', glLineId: 'l1', entryNumber: 'JE-1', entryDate: '2026-10-20', memo: 'Compressor replacement', sourceModule: 'BILL', counterparty: 'New Mech Co', amountCents: 1_250_000, tags: ['LARGEST', 'NEW_COUNTERPARTY', 'ONE_OFF'] },
    { ref: 'L2', glEntryId: 'e2', glLineId: 'l2', entryNumber: 'JE-2', entryDate: '2026-10-05', memo: 'Filters', sourceModule: 'BILL', counterparty: 'Acme', amountCents: 250_000, tags: ['LARGEST'] },
  ],
  counterparties: [
    { counterparty: 'New Mech Co', currentCents: 1_250_000, comparisonCents: 0, changeCents: 1_250_000, isNew: true },
    { counterparty: 'Acme', currentCents: 250_000, comparisonCents: 200_000, changeCents: 50_000, isNew: false },
  ],
  activityCents: 1_500_000,
  lineCount: 2,
};
const SHEET = buildFactSheet(LINE, DRIVERS, '2026-10');
const deps = (key: string | null) => ({ supabase: {} as SupabaseClient, anthropicApiKey: key });
const gw = (text: string) => ({ status: 'ok', result: [{ type: 'text', text }], model_used: 'm', tokens: { input: 1, output: 1 }, cost_cents: 1, correlation_id: 'c', budget: { state: 'under' }, message: null });

beforeEach(() => runAiGateway.mockReset());

describe('fact sheet + driver summary', () => {
  it('lists figures and refs the draft may use', () => {
    expect(SHEET.refs).toEqual(['L1', 'L2']);
    expect(SHEET.allowedCents).toEqual(expect.arrayContaining([1_500_000, 200_000, 1_300_000, 1_250_000, 50_000]));
    expect(SHEET.text).toContain('L1: 2026-10-20 $12,500.00 — New Mech Co');
  });

  it('the driver summary states the move and the biggest movers', () => {
    const s = driverSummary(LINE, DRIVERS);
    expect(s).toContain('up $13,000.00 (650.0%)');
    expect(s).toContain('New Mech Co +$12,500.00 (new)');
    expect(s).toContain('One-off: $12,500.00');
  });
});

describe('verifyDraft', () => {
  it('accepts figures quoted exactly or to the whole dollar, with known citations', () => {
    expect(verifyDraft('Repairs rose $13,000.00 (650.0%), mostly a $12,500 compressor from New Mech Co.', ['L1'], SHEET)).toEqual({ ok: true, problems: [] });
  });

  it('refuses an untraceable $ figure', () => {
    const v = verifyDraft('Repairs rose $14,200 because of a compressor.', ['L1'], SHEET);
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/\$14,200/);
  });

  it('refuses an untraceable %', () => {
    expect(verifyDraft('Repairs rose 42% on a compressor.', ['L1'], SHEET).ok).toBe(false);
  });

  it('refuses unknown or missing citations', () => {
    expect(verifyDraft('A compressor was replaced.', ['L9'], SHEET).ok).toBe(false);
    expect(verifyDraft('A compressor was replaced.', [], SHEET).ok).toBe(false);
  });

  it('parses the JSON reply (fences tolerated)', () => {
    expect(parseDraftReply('```json\n{"explanation":"A one-off compressor.","category":"ONE_TIME","citations":["L1"]}\n```')).toEqual({ explanation: 'A one-off compressor.', category: 'ONE_TIME', citations: ['L1'] });
    expect(parseDraftReply('not json')).toBeNull();
    expect(parseDraftReply('{"explanation":"ok","category":"BOGUS"}')).toEqual({ explanation: 'ok', category: null, citations: [] });
  });
});

describe('draftFluxExplanation — AI-down fallback', () => {
  const args = { orgId: 'org', userId: 'u', sheet: SHEET };

  it('no key ⇒ unavailable, gateway never called', async () => {
    expect(await draftFluxExplanation(deps(null), args)).toMatchObject({ kind: 'unavailable' });
    expect(runAiGateway).not.toHaveBeenCalled();
  });

  it('a disabled provider (thrown) ⇒ unavailable, never a 500', async () => {
    runAiGateway.mockRejectedValueOnce(new Error('This organization has been disabled.'));
    expect(await draftFluxExplanation(deps('k'), args)).toMatchObject({ kind: 'unavailable', message: 'AI is temporarily unavailable.' });
  });

  it('budget blocked ⇒ unavailable', async () => {
    runAiGateway.mockResolvedValueOnce({ ...gw(''), status: 'blocked', result: null, message: 'Monthly AI budget reached' });
    expect(await draftFluxExplanation(deps('k'), args)).toEqual({ kind: 'unavailable', message: 'Monthly AI budget reached' });
  });

  it('a draft that invents a number is refused', async () => {
    runAiGateway.mockResolvedValueOnce(gw('{"explanation":"Repairs rose $99,999 on new equipment.","category":"ONE_TIME","citations":["L1"]}'));
    expect(await draftFluxExplanation(deps('k'), args)).toMatchObject({ kind: 'refused' });
  });

  it('a traceable draft comes back for a person to edit (routed through the gateway)', async () => {
    runAiGateway.mockResolvedValueOnce(gw('{"explanation":"A one-off $12,500 compressor replacement from a new vendor, New Mech Co.","category":"ONE_TIME","citations":["L1"]}'));
    const r = await draftFluxExplanation(deps('k'), args);
    expect(r).toMatchObject({ kind: 'draft', category: 'ONE_TIME', citations: ['L1'], correlationId: 'c' });
    expect(runAiGateway.mock.calls[0][1]).toMatchObject({ tenant_id: 'org', module: 'BOOKS', feature: 'FLUX_EXPLAIN' });
  });
});
