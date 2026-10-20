import { describe, expect, it } from 'vitest';
import {
  ABSTAIN_BELOW, CATALOG_KEYS, CONFIGURATOR_TOOL_NAME, UNVERIFIED_CONFIDENCE_CAP, buildConfiguratorTool, classify,
  mergeAiAndRules, validateAiProposal, type ClassifyResult,
} from '../index';
import { CLASSIFIER_FIXTURES, GIBBERISH } from './fixtures';

describe('rules classifier fixtures', () => {
  const cases = Object.entries(CLASSIFIER_FIXTURES).flatMap(([pack, list]) => list.map((d) => [pack, d] as const));

  it('covers every pack with at least 3 fixtures', () => {
    for (const key of CATALOG_KEYS) expect(CLASSIFIER_FIXTURES[key]?.length ?? 0, key).toBeGreaterThanOrEqual(3);
  });

  it.each(cases)('%s ← "%s"', (pack, description) => {
    const r = classify({ description });
    expect(r.candidates[0]?.packKey).toBe(pack);
    expect(r.abstain).toBe(false);
    expect(r.candidates[0].source).toBe('rules');
    expect(r.candidates[0].reasons.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < r.candidates.length; i++) {
      expect(r.candidates[i - 1].confidence).toBeGreaterThanOrEqual(r.candidates[i].confidence);
    }
  });

  it('reports overall accuracy of 100% on the fixture set', () => {
    const hits = cases.filter(([pack, d]) => classify({ description: d }).candidates[0]?.packKey === pack).length;
    expect(hits / cases.length).toBe(1);
  });

  it('reasons quote the matched words from the input', () => {
    const r = classify({ description: 'we install and service furnaces and AC, about 12 trucks, moving off ServiceTitan' });
    const reasons = r.candidates[0].reasons.join(' | ');
    expect(reasons).toContain('"ServiceTitan" in your description');
    expect(reasons).toContain('"furnaces"');
    expect(reasons).toContain('"trucks"');
  });

  it('matches spaced and joined spellings of product names', () => {
    expect(classify({ description: 'We moved off Service Titan last year' }).candidates[0].packKey).toBe('field_service');
    expect(classify({ description: 'mostly on pricebook flat rates' }).candidates[0].packKey).toBe('field_service');
    expect(classify({ description: 'we import from c-Systems Infinity' }).candidates[0].packKey).toBe('equipment_dealer');
  });

  it('a longer phrase claims its words (dye lots are not real-estate lots)', () => {
    const r = classify({ description: 'we track dye lots and remnants' });
    expect(r.candidates.map((c) => c.packKey)).not.toContain('real_estate_development');
  });
});

describe('abstain', () => {
  it.each(GIBBERISH)('abstains on gibberish: %s', (description) => {
    const r = classify({ description });
    expect(r.abstain).toBe(true);
    expect(r.candidates).toEqual([]);
  });

  it('abstains on empty input and on weak, ambiguous evidence', () => {
    expect(classify({}).abstain).toBe(true);
    const weak = classify({ description: 'we do tile' });
    expect(weak.abstain).toBe(true);
    expect(weak.candidates[0]?.confidence ?? 0).toBeLessThan(ABSTAIN_BELOW);
  });

  it('abstains when two packs tie below the ceiling', () => {
    // "bath" (remodel 1.0) vs "measure" (flooring 0.6) + "installer" (1.2): close and both weak
    const r = classify({ description: 'bath measure' });
    expect(r.abstain).toBe(true);
  });
});

describe('tile, NAICS, Books hints and file headers', () => {
  it('a picked tile is confidence 1 and never abstains', () => {
    const r = classify({ tilePackKey: 'interior_design', description: 'kitchen and bath remodels' });
    expect(r.candidates[0]).toMatchObject({ packKey: 'interior_design', confidence: 1, source: 'tile' });
    expect(r.candidates[1].packKey).toBe('residential_remodel');
    expect(r.abstain).toBe(false);
  });

  it('ignores an unknown tile', () => {
    expect(classify({ tilePackKey: 'spaceships' }).abstain).toBe(true);
  });

  it('scores NAICS exact above prefix', () => {
    const hvac = classify({ naics: '238220' });
    expect(hvac.candidates[0].packKey).toBe('field_service');
    expect(hvac.candidates[0].reasons[0]).toContain('NAICS 238220');
    expect(hvac.candidates[1].packKey).toBe('specialty_trade');
    expect(classify({ naics: '541410' }).candidates[0].packKey).toBe('interior_design');
    expect(classify({ naics: '236118' }).candidates[0].packKey).toBe('residential_remodel');
    expect(classify({ naics: '541611' }).candidates[0].packKey).toBe('professional_services');
  });

  it('uses the Books industry, company name and rev-rec method', () => {
    const r = classify({ companyIndustry: 'Flooring', companyName: 'Heritage Interiors' });
    expect(r.candidates[0].packKey).toBe('flooring');
    expect(r.candidates[0].reasons[0]).toContain('the company industry in Books');
    const rec = classify({ revRecMethod: 'SUBSCRIPTION', description: 'we do maintenance agreements' });
    expect(rec.candidates[0].packKey).toBe('field_service');
    expect(rec.candidates[0].reasons.join(' ')).toContain('Books recognizes revenue subscription');
    const ratable = classify({ revRecMethod: 'RATABLY' });
    expect(ratable.candidates.map((c) => c.packKey).sort()).toEqual(['field_service', 'professional_services']);
    expect(ratable.abstain).toBe(true); // a rev-rec method alone is not enough to guess
    expect(classify({ revRecMethod: 'POINT_OF_SALE' }).candidates).toEqual([]); // the Books default says nothing
  });

  it('reads uploaded file headers', () => {
    const r = classify({ fileHeaders: ['Order #', 'Customer', 'Style', 'Dye Lot', 'Roll #', 'Installer'] });
    expect(r.candidates[0].packKey).toBe('flooring');
    expect(r.candidates[0].reasons.join(' ')).toContain('your file headers');
  });
});

describe('configurator tool definition', () => {
  const tool = buildConfiguratorTool();
  const props = (tool.input_schema as { properties: Record<string, any> }).properties;

  it('is named propose_configuration with a closed pack enum and at most 3 packs', () => {
    expect(tool.name).toBe(CONFIGURATOR_TOOL_NAME);
    expect(tool.name).toBe('propose_configuration');
    expect(props.packs.maxItems).toBe(3);
    expect(props.packs.items.properties.pack_id.enum).toEqual([...CATALOG_KEYS]);
    expect(Object.keys(props).sort()).toEqual(['abstain', 'evidence', 'packs', 'params', 'prefilled_answers']);
    expect((tool.input_schema as { required: string[] }).required).toEqual(expect.arrayContaining(['packs', 'evidence', 'abstain']));
    expect(tool.description).toContain('field_service');
    expect(tool.description).toContain('retainage_pct (fraction 0..0.2)');
    expect(JSON.parse(JSON.stringify(tool))).toEqual(tool);
  });
});

describe('validateAiProposal', () => {
  const input = { description: 'We do HVAC service and replacements, about 30% of revenue is commercial work. We sell tune-up memberships.' };

  it('keeps known packs, verified evidence and valid answers', () => {
    const r = validateAiProposal({
      packs: [{ pack_id: 'field_service', confidence: 0.92 }, { pack_id: 'specialty_trade', confidence: 0.3 }],
      params: { primary_trade: 'hvac', member_discount_pct: 0.1 },
      prefilled_answers: [
        { question_key: 'does_commercial', value: true, evidence: '30% of revenue is commercial work' },
        { question_key: 'sells_memberships', value: true, evidence: 'We sell tune-up memberships' },
      ],
      evidence: ['HVAC service and replacements'],
      abstain: false,
    }, input);
    expect(r.result.candidates.map((c) => c.packKey)).toEqual(['field_service', 'specialty_trade']);
    expect(r.result.candidates[0]).toMatchObject({ confidence: 0.92, source: 'ai' });
    expect(r.result.candidates[0].reasons[0]).toBe('You wrote "HVAC service and replacements"');
    expect(r.params.member_discount_pct).toBe(0.1);
    expect(r.params.labor_rate_cents).toBe(14500);
    expect(r.paramsFellBack).toBe(false);
    expect(Object.keys(r.prefilledAnswers).sort()).toEqual(['does_commercial', 'sells_memberships']);
    expect(r.rejected).toEqual([]);
  });

  it('rejects fabricated evidence and caps confidence when nothing is verified', () => {
    const r = validateAiProposal({
      packs: [{ pack_id: 'field_service', confidence: 0.95 }],
      prefilled_answers: [{ question_key: 'does_commercial', value: true, evidence: 'we have a large commercial division' }],
      evidence: ['we run 40 trucks across three states'],
      abstain: false,
    }, input);
    expect(r.evidence).toEqual([]);
    expect(r.rejected.map((x) => x.kind)).toEqual(['evidence', 'answer']);
    expect(r.prefilledAnswers).toEqual({});
    expect(r.result.candidates[0].confidence).toBe(UNVERIFIED_CONFIDENCE_CAP);
  });

  it('drops unknown pack ids, unknown questions and invalid answer values', () => {
    const r = validateAiProposal({
      packs: [{ pack_id: 'hvac_super_pack', confidence: 0.99 }, { pack_id: 'field_service', confidence: 0.8 }],
      prefilled_answers: [
        { question_key: 'favorite_color', value: 'blue', evidence: 'HVAC service' },
        { question_key: 'repair_pricing', value: 'BARTER', evidence: 'HVAC service' },
      ],
      evidence: ['HVAC service'],
      abstain: false,
    }, input);
    expect(r.result.candidates.map((c) => c.packKey)).toEqual(['field_service']);
    expect(r.rejected.filter((x) => x.kind === 'pack')).toHaveLength(1);
    expect(r.rejected.filter((x) => x.kind === 'answer')).toHaveLength(2);
  });

  it('falls back to default params with a flag when the AI params are out of bounds', () => {
    const r = validateAiProposal({
      packs: [{ pack_id: 'commercial_gc', confidence: 0.9 }],
      params: { retainage_pct: 0.35, made_up_param: true },
      evidence: [],
      abstain: false,
    }, { description: 'commercial GC' });
    expect(r.paramsFellBack).toBe(true);
    expect(r.params.retainage_pct).toBe(0.1);
    expect(r.rejected.some((x) => x.kind === 'params')).toBe(true);
  });

  it('treats a malformed payload as an abstain', () => {
    const r = validateAiProposal({ packs: 'field_service' }, input);
    expect(r.result).toEqual({ candidates: [], abstain: true });
    expect(r.rejected[0].kind).toBe('shape');
    expect(validateAiProposal(null, input).result.abstain).toBe(true);
  });
});

describe('mergeAiAndRules', () => {
  const rules = (packKey: string, confidence: number, source: 'rules' | 'tile' = 'rules'): ClassifyResult => ({
    candidates: [{ packKey, confidence, reasons: ['rule'], source }],
    abstain: false,
  });
  const ai = (packKey: string, confidence: number): ClassifyResult => ({
    candidates: [{ packKey, confidence, reasons: ['ai'], source: 'ai' }],
    abstain: false,
  });

  it('AI wins by default', () => {
    const m = mergeAiAndRules(rules('residential_remodel', 0.7), ai('interior_design', 0.8));
    expect(m.candidates.map((c) => c.packKey)).toEqual(['interior_design', 'residential_remodel']);
  });

  it('confident rules beat an unsure AI', () => {
    const m = mergeAiAndRules(rules('flooring', 0.9), ai('interior_design', 0.55));
    expect(m.candidates[0].packKey).toBe('flooring');
  });

  it('confident rules still lose to a confident AI', () => {
    expect(mergeAiAndRules(rules('flooring', 0.9), ai('interior_design', 0.7)).candidates[0].packKey).toBe('interior_design');
  });

  it('marks agreement as merged and unions reasons', () => {
    const m = mergeAiAndRules(rules('flooring', 0.9), ai('flooring', 0.8));
    expect(m.candidates).toEqual([{ packKey: 'flooring', confidence: 0.8, reasons: ['ai', 'rule'], source: 'merged' }]);
  });

  it('a picked tile always wins; AI abstain falls back to rules; rules abstain defers to AI', () => {
    expect(mergeAiAndRules(rules('flooring', 1, 'tile'), ai('interior_design', 0.99)).candidates[0].packKey).toBe('flooring');
    expect(mergeAiAndRules(rules('flooring', 0.5), { candidates: [], abstain: true }).candidates[0].packKey).toBe('flooring');
    const m = mergeAiAndRules({ candidates: [], abstain: true }, ai('general', 0.7));
    expect(m).toEqual({ candidates: [{ packKey: 'general', confidence: 0.7, reasons: ['ai'], source: 'ai' }], abstain: false });
  });

  it('accepts a validateAiProposal result directly', () => {
    const v = validateAiProposal({ packs: [{ pack_id: 'flooring', confidence: 0.9 }], evidence: ['carpet'], abstain: false }, { description: 'we sell carpet' });
    const m = mergeAiAndRules(classify({ description: 'we sell carpet' }), v);
    expect(m.candidates[0]).toMatchObject({ packKey: 'flooring', source: 'merged' });
  });
});
