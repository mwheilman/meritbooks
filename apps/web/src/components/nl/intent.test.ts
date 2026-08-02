import { describe, it, expect, vi } from 'vitest';
import {
  rulesClassify,
  parseClassification,
  buildRouteResult,
  resolveNavigation,
  classifyAndRoute,
  CLARIFY_THRESHOLD,
  type Classification,
} from './intent';

describe('rulesClassify (fast verb pre-filter)', () => {
  it('routes an explicit nav verb + known target to NAVIGATION', () => {
    const c = rulesClassify('take me to the bank feed');
    expect(c?.lane).toBe('NAVIGATION');
    expect(c!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('routes a record verb to PROCESSING P1', () => {
    const c = rulesClassify('accrue $4,200 of rent for Coho for July');
    expect(c?.lane).toBe('PROCESSING');
    expect(c?.intent).toBe('P1_RECORD_JE');
  });

  it('routes a code/categorize verb to PROCESSING P2', () => {
    const c = rulesClassify('code the last 5 Home Depot charges to job materials');
    expect(c?.lane).toBe('PROCESSING');
    expect(c?.intent).toBe('P2_CATEGORIZE');
  });

  it('routes an "enter a bill from …" to PROCESSING P3 (not a journal entry)', () => {
    const c = rulesClassify('enter a $1,200 bill from Acme due next Friday');
    expect(c?.lane).toBe('PROCESSING');
    expect(c?.intent).toBe('P3_CREATE_BILL');
  });

  it('routes a leading "invoice <customer>" to PROCESSING P4', () => {
    const c = rulesClassify('invoice Coho $5k for June retainer');
    expect(c?.lane).toBe('PROCESSING');
    expect(c?.intent).toBe('P4_CREATE_INVOICE');
  });

  it('routes "create an invoice for X" to PROCESSING P4', () => {
    const c = rulesClassify('create an invoice for Heartland for the Phase 2 milestone');
    expect(c?.intent).toBe('P4_CREATE_INVOICE');
  });

  it('routes a why/what question to ANALYTICAL', () => {
    const c = rulesClassify('why did OpEx jump in July?');
    expect(c?.lane).toBe('ANALYTICAL');
  });

  it('abstains on a retired capability', () => {
    const c = rulesClassify('run the overhead rate chargeback');
    expect(c?.lane).toBe('ABSTAIN');
    expect(c?.intent).toBe('RETIRED_CAPABILITY');
  });

  it('returns null (defer to model) on an ambiguous prompt', () => {
    expect(rulesClassify('the coho thing from last week')).toBeNull();
  });
});

describe('resolveNavigation', () => {
  it('matches the longest keyword', () => {
    expect(resolveNavigation('open the chart of accounts')?.href).toBe('/chart-of-accounts');
  });
  it('returns null when nothing matches', () => {
    expect(resolveNavigation('xyzzy nowhere')).toBeNull();
  });
});

describe('parseClassification (fail-closed)', () => {
  it('parses a clean JSON classification', () => {
    const c = parseClassification('{"lane":"ANALYTICAL","intent":"A_QUERY","entities":{"company":"Coho"},"confidence":0.9,"clarifyingQuestion":null}');
    expect(c.lane).toBe('ANALYTICAL');
    expect(c.entities.company).toBe('Coho');
    expect(c.confidence).toBe(0.9);
  });
  it('strips markdown fences', () => {
    const c = parseClassification('```json\n{"lane":"NAVIGATION","intent":"N1_NAVIGATE","entities":{},"confidence":0.8,"clarifyingQuestion":null}\n```');
    expect(c.lane).toBe('NAVIGATION');
  });
  it('fails closed to ABSTAIN on unparseable text', () => {
    const c = parseClassification('not json at all');
    expect(c.lane).toBe('ABSTAIN');
    expect(c.confidence).toBe(0);
  });
  it('coerces an unknown lane to ABSTAIN', () => {
    const c = parseClassification('{"lane":"HACK","intent":"x","entities":{},"confidence":1}');
    expect(c.lane).toBe('ABSTAIN');
  });
});

describe('buildRouteResult (lane mapping)', () => {
  const mk = (over: Partial<Classification>): Classification => ({
    lane: 'PROCESSING',
    intent: 'P1_RECORD_JE',
    entities: {},
    confidence: 0.9,
    clarifyingQuestion: null,
    ...over,
  });

  it('PROCESSING P1 → processing directive carrying the prompt as description', () => {
    const r = buildRouteResult(mk({}), 'accrue $4,200 rent for Coho', { degraded: false });
    expect(r.lane).toBe('PROCESSING');
    expect(r.processing?.kind).toBe('P1_RECORD_JE');
    expect(r.processing?.description).toBe('accrue $4,200 rent for Coho');
  });

  it('PROCESSING P2 → categorize directive', () => {
    const r = buildRouteResult(mk({ intent: 'P2_CATEGORIZE' }), 'code the last 5 charges', { degraded: false });
    expect(r.processing?.kind).toBe('P2_CATEGORIZE');
  });

  it('PROCESSING P3 → create-bill directive', () => {
    const r = buildRouteResult(mk({ intent: 'P3_CREATE_BILL' }), 'enter a $1,200 bill from Acme', { degraded: false });
    expect(r.processing?.kind).toBe('P3_CREATE_BILL');
    expect(r.processing?.description).toBe('enter a $1,200 bill from Acme');
  });

  it('PROCESSING P4 → create-invoice directive', () => {
    const r = buildRouteResult(mk({ intent: 'P4_CREATE_INVOICE' }), 'invoice Coho $5k', { degraded: false });
    expect(r.processing?.kind).toBe('P4_CREATE_INVOICE');
  });

  it('ANALYTICAL → forwards the prompt for /api/nl/query', () => {
    const r = buildRouteResult(mk({ lane: 'ANALYTICAL', intent: 'A_QUERY' }), 'cash on hand for Heartland', { degraded: false });
    expect(r.lane).toBe('ANALYTICAL');
    expect(r.analytical?.prompt).toBe('cash on hand for Heartland');
  });

  it('NAVIGATION → resolves a destination', () => {
    const r = buildRouteResult(mk({ lane: 'NAVIGATION', intent: 'N1_NAVIGATE' }), 'open the bank feed', { degraded: false });
    expect(r.lane).toBe('NAVIGATION');
    expect(r.navigation?.href).toBe('/bank-feed');
  });

  it('NAVIGATION with no matchable target → ABSTAIN with a suggestion', () => {
    const r = buildRouteResult(mk({ lane: 'NAVIGATION', intent: 'N1_NAVIGATE' }), 'take me somewhere', { degraded: false });
    expect(r.lane).toBe('ABSTAIN');
    expect(r.abstain?.suggestion).toBeTruthy();
  });

  it('ABSTAIN → carries reason + suggestion', () => {
    const r = buildRouteResult(mk({ lane: 'ABSTAIN', intent: 'UNKNOWN', confidence: 0 }), 'blah', { degraded: false });
    expect(r.abstain?.reason).toBeTruthy();
  });

  it('low confidence → clarify before acting', () => {
    const r = buildRouteResult(mk({ confidence: CLARIFY_THRESHOLD - 0.1 }), 'do the thing', { degraded: false });
    expect(r.clarifyingQuestion).toBeTruthy();
  });
});

describe('classifyAndRoute (rules-first, gateway fallback, degrade)', () => {
  it('short-circuits on a high-confidence rule without calling the gateway', async () => {
    const classify = vi.fn();
    const { result, usedGateway } = await classifyAndRoute('take me to the bank feed', undefined, classify);
    expect(usedGateway).toBe(false);
    expect(classify).not.toHaveBeenCalled();
    expect(result.lane).toBe('NAVIGATION');
  });

  it('calls the (mocked) gateway when rules cannot classify', async () => {
    const classify = vi.fn(async (): Promise<Classification> => ({
      lane: 'ANALYTICAL',
      intent: 'A_QUERY',
      entities: {},
      confidence: 0.88,
      clarifyingQuestion: null,
    }));
    const { result, usedGateway } = await classifyAndRoute('the coho situation this quarter', undefined, classify);
    expect(usedGateway).toBe(true);
    expect(classify).toHaveBeenCalledOnce();
    expect(result.lane).toBe('ANALYTICAL');
  });

  it('degrades gracefully when the gateway throws (budget block / no key)', async () => {
    const classify = vi.fn(async (): Promise<Classification> => {
      throw new Error('AI budget reached');
    });
    const { result } = await classifyAndRoute('summarize my quarter narratively', undefined, classify);
    expect(result.degraded).toBe(true);
    expect(result.lane).toBe('ABSTAIN');
    expect(result.abstain?.reason).toContain('AI is paused');
  });

  it('degrades to a rules match when one exists even if the gateway is down', async () => {
    const classify = vi.fn(async (): Promise<Classification> => {
      throw new Error('blocked');
    });
    // "why ..." is a rules ANALYTICAL match (confidence 0.8) so it short-circuits before classify.
    const { result, usedGateway } = await classifyAndRoute('why did revenue drop', undefined, classify);
    expect(usedGateway).toBe(false);
    expect(result.lane).toBe('ANALYTICAL');
  });
});
