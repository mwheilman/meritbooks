/**
 * Pack classification. Rules first (tile, NAICS, weighted keywords, rev-rec method), AI second
 * through a forced tool whose output is validated here. No network calls: the caller sends the
 * tool definition to the Core gateway and passes the raw tool input back to validateAiProposal().
 */
import { z } from 'zod';
import { ARCHETYPES, REV_REC_HINTS, type ClassifyInput, type ClassifyResult, type PackCandidate, type RevRecHint } from './types';
import { CATALOG_KEYS, isPackKey, resolveManifest } from './catalog';
import { normalizeForQuote, tokenize, tokenizeRaw, type Token } from './text';
import { checkParams, type ParamValue } from './params';
import { isValidAnswer, type AnswerValue } from './effects';

// ---------------------------------------------------------------------------
// Tunables (documented so the thresholds are reviewable)
// ---------------------------------------------------------------------------

/** confidence = 1 − exp(−raw / SCALE): one strong keyword (3.0) ≈ 0.70, two ≈ 0.91. */
export const CONFIDENCE_SCALE = 2.5;
export const ABSTAIN_BELOW = 0.35;
export const AMBIGUITY_GAP = 0.08;
export const AMBIGUITY_CEILING = 0.6;
export const MAX_CANDIDATES = 3;

const FIELD_WEIGHT = { description: 1.0, companyIndustry: 1.0, companyName: 0.6, fileHeaders: 0.8 } as const;
type Field = keyof typeof FIELD_WEIGHT;
const FIELD_LABEL: Record<Field, string> = {
  description: 'your description',
  companyIndustry: 'the company industry in Books',
  companyName: 'the company name',
  fileHeaders: 'your file headers',
};

const NAICS_EXACT = 3.0;
const RECURRING_FAMILY: readonly RevRecHint[] = ['SUBSCRIPTION', 'RATABLY'];
const POC_FAMILY: readonly RevRecHint[] = ['PCT_COSTS_INCURRED', 'PCT_COMPLETE'];

// ---------------------------------------------------------------------------
// Keyword index (built once from the catalog)
// ---------------------------------------------------------------------------

interface IndexedKeyword {
  packKey: string;
  term: string;
  weight: number;
  stems: string[];
  compact: string;
}

let INDEX: IndexedKeyword[] | null = null;
function keywordIndex(): IndexedKeyword[] {
  if (INDEX) return INDEX;
  INDEX = [];
  for (const key of CATALOG_KEYS) {
    const m = resolveManifest(key);
    for (const k of m.keywords) {
      const stems = tokenize(k.term);
      if (stems.length === 0) continue;
      INDEX.push({ packKey: key, term: k.term, weight: k.weight, stems, compact: stems.join('') });
    }
  }
  // Longest phrases claim their tokens first, so "dye lots" is not also a real-estate "lot" and
  // "for general contractors" is not also a "general contractor".
  INDEX.sort((a, b) => b.stems.length - a.stems.length || b.compact.length - a.compact.length || b.weight - a.weight);
  return INDEX;
}

/**
 * Find a keyword among the tokens not yet claimed by a longer keyword: phrase match on stems, or a
 * compact match ("Service Titan" ≈ "ServiceTitan"). Claims the matched tokens.
 */
function claimKeyword(kw: IndexedKeyword, tokens: Token[], claimed: (string | null)[]): string | null {
  const phrase = kw.stems.join(' ');
  const take = (i: number, w: number): string => {
    for (let j = 0; j < w; j++) claimed[i + j] = phrase;
    return tokens.slice(i, i + w).map((t) => t.raw).join(' ');
  };
  // the same phrase in another pack may reuse the tokens; a longer phrase may not be split
  const free = (i: number, w: number): boolean => {
    for (let j = 0; j < w; j++) if (claimed[i + j] !== null && claimed[i + j] !== phrase) return false;
    return true;
  };
  const n = kw.stems.length;
  for (let i = 0; i + n <= tokens.length; i++) {
    if (!free(i, n)) continue;
    let ok = true;
    for (let j = 0; j < n; j++) if (tokens[i + j].stem !== kw.stems[j]) { ok = false; break; }
    if (ok) return take(i, n);
  }
  if (kw.compact.length >= 5) {
    for (let w = 1; w <= 3; w++) {
      if (w === n) continue;
      for (let i = 0; i + w <= tokens.length; i++) {
        if (!free(i, w)) continue;
        let joined = '';
        for (let j = 0; j < w; j++) joined += tokens[i + j].stem;
        if (joined === kw.compact) return take(i, w);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rules classifier
// ---------------------------------------------------------------------------

interface Contribution {
  points: number;
  reason: string;
}

function booksMethodToHint(method: string | undefined): RevRecHint | null {
  if (!method) return null;
  const m = method.trim().toUpperCase();
  // POINT_OF_SALE is the Books default for every company, and CASH says nothing about the work.
  if (m === 'POINT_OF_SALE' || m === 'CASH' || m === 'POINT_IN_TIME') return null;
  return (REV_REC_HINTS as readonly string[]).includes(m) ? (m as RevRecHint) : null;
}

function revRecFamily(h: RevRecHint): readonly RevRecHint[] {
  if (RECURRING_FAMILY.includes(h)) return RECURRING_FAMILY;
  if (POC_FAMILY.includes(h)) return POC_FAMILY;
  return [h];
}

function toConfidence(raw: number): number {
  return Math.round((1 - Math.exp(-raw / CONFIDENCE_SCALE)) * 1000) / 1000;
}

function naicsPoints(input: string, packCodes: readonly string[]): { points: number; code: string } | null {
  let best: { points: number; code: string } | null = null;
  for (const code of packCodes) {
    let pts = 0;
    if (input === code) pts = NAICS_EXACT;
    else if (input.startsWith(code)) pts = 1.5 + 0.25 * Math.max(0, code.length - 2); // pack code is broader
    else if (code.startsWith(input) && input.length >= 3) pts = 1.0; // the input is broader
    if (pts > 0 && (!best || pts > best.points)) best = { points: pts, code };
  }
  return best;
}

function finalize(scored: { packKey: string; raw: number; contributions: Contribution[] }[]): ClassifyResult {
  const ranked = scored
    .filter((s) => s.raw > 0)
    .map((s) => ({
      packKey: s.packKey,
      confidence: toConfidence(s.raw),
      reasons: s.contributions.sort((a, b) => b.points - a.points).slice(0, 5).map((c) => c.reason),
      source: 'rules' as const,
    }))
    .sort((a, b) => b.confidence - a.confidence || CATALOG_KEYS.indexOf(a.packKey) - CATALOG_KEYS.indexOf(b.packKey))
    .slice(0, MAX_CANDIDATES);
  const top = ranked[0]?.confidence ?? 0;
  const second = ranked[1]?.confidence ?? 0;
  const ambiguous = ranked.length > 1 && top - second < AMBIGUITY_GAP && top < AMBIGUITY_CEILING && second < AMBIGUITY_CEILING;
  return { candidates: ranked, abstain: top < ABSTAIN_BELOW || ambiguous };
}

/** Rules-only scoring of every pack (no tile handling). */
export function scorePacks(input: ClassifyInput): { packKey: string; raw: number; contributions: Contribution[] }[] {
  const fields: { field: Field; tokens: Token[]; claimed: (string | null)[] }[] = [];
  const addField = (field: Field, text: string | undefined) => {
    if (!text) return;
    const tokens = tokenizeRaw(text);
    fields.push({ field, tokens, claimed: tokens.map(() => null) });
  };
  addField('description', input.description);
  addField('companyIndustry', input.companyIndustry);
  addField('companyName', input.companyName);
  addField('fileHeaders', input.fileHeaders?.join(' | '));

  const byPack = new Map<string, { raw: number; contributions: Contribution[] }>();
  const bump = (packKey: string, points: number, reason: string) => {
    const cur = byPack.get(packKey) ?? { raw: 0, contributions: [] };
    cur.raw += points;
    cur.contributions.push({ points, reason });
    byPack.set(packKey, cur);
  };

  for (const kw of keywordIndex()) {
    let best: { points: number; field: Field; quote: string } | null = null;
    for (const f of fields) {
      const quote = claimKeyword(kw, f.tokens, f.claimed);
      if (quote === null) continue;
      const points = kw.weight * FIELD_WEIGHT[f.field];
      if (!best || points > best.points) best = { points, field: f.field, quote };
    }
    if (best) bump(kw.packKey, best.points, `"${best.quote}" in ${FIELD_LABEL[best.field]}`);
  }

  const naics = input.naics?.replace(/\D/g, '');
  if (naics && naics.length >= 2) {
    for (const key of CATALOG_KEYS) {
      const hit = naicsPoints(naics, resolveManifest(key).naics);
      if (hit) bump(key, hit.points, `NAICS ${naics} ${naics === hit.code ? 'is' : 'falls under'} ${hit.code}`);
    }
  }

  const hint = booksMethodToHint(input.revRecMethod);
  if (hint) {
    const family = revRecFamily(hint);
    const points = family === RECURRING_FAMILY ? 0.8 : 0.4;
    for (const key of CATALOG_KEYS) {
      const m = resolveManifest(key);
      if (m.jobTypes.some((j) => j.revRecHint && family.includes(j.revRecHint))) {
        bump(key, points, `Books recognizes revenue ${hint.toLowerCase().replace(/_/g, ' ')}`);
      }
    }
  }

  return CATALOG_KEYS.map((packKey) => ({ packKey, ...(byPack.get(packKey) ?? { raw: 0, contributions: [] }) }));
}

/** Deterministic rules classifier. A picked tile is confidence 1. */
export function classify(input: ClassifyInput): ClassifyResult {
  const rules = finalize(scorePacks(input));
  if (input.tilePackKey && isPackKey(input.tilePackKey)) {
    const m = resolveManifest(input.tilePackKey);
    const tile: PackCandidate = {
      packKey: m.key,
      confidence: 1,
      reasons: [`You picked "${m.tile.label}"`],
      source: 'tile',
    };
    const others = rules.candidates.filter((c) => c.packKey !== m.key).slice(0, MAX_CANDIDATES - 1);
    return { candidates: [tile, ...others], abstain: false };
  }
  return rules;
}

// ---------------------------------------------------------------------------
// AI: tool definition, validation, merge
// ---------------------------------------------------------------------------

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const CONFIGURATOR_TOOL_NAME = 'propose_configuration';

function describeCatalogForTool(): string {
  return CATALOG_KEYS.map((key) => {
    const m = resolveManifest(key);
    const params = Object.entries(m.params).map(([k, p]) => {
      if (p.type === 'enum') return `${k} (one of ${(p.options ?? []).join('|')})`;
      if (p.type === 'percent') return `${k} (fraction ${p.min ?? 0}..${p.max ?? 1})`;
      if (p.type === 'integer') return `${k} (integer${p.min !== undefined ? ` ${p.min}..${p.max ?? ''}` : ''})`;
      return `${k} (true|false)`;
    });
    const questions = m.questions.map((q) => {
      const a = q.answer;
      const shape = a.type === 'bool' ? 'true|false'
        : a.type === 'percent' ? `fraction ${a.min}..${a.max}`
          : `${a.type === 'multi' ? 'list of ' : ''}${a.options.map((o) => o.value).join('|')}`;
      return `${q.key} (${shape})`;
    });
    return `- ${key}: ${m.name}. ${m.tagline} Params: ${params.join(', ') || 'none'}. Questions: ${questions.join(', ') || 'none'}.`;
  }).join('\n');
}

/** The forced tool sent to the model. pack_id is an enum of the catalog, so the model can only choose. */
export function buildConfiguratorTool(): AnthropicToolDefinition {
  return {
    name: CONFIGURATOR_TOOL_NAME,
    description: [
      'Choose up to 3 industry packs for this company from the catalog below, most likely first,',
      'fill parameters for the first pack only, and prefill follow-up answers only when the user said so.',
      'Every prefilled answer and every evidence item must quote the user\'s own words exactly.',
      'Set abstain to true when the input does not say what kind of work the company does.',
      'Catalog:',
      describeCatalogForTool(),
    ].join('\n'),
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packs: {
          type: 'array',
          maxItems: MAX_CANDIDATES,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pack_id: { type: 'string', enum: [...CATALOG_KEYS] },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              archetypes: { type: 'array', items: { type: 'string', enum: [...ARCHETYPES] } },
              reason: { type: 'string', maxLength: 200 },
            },
            required: ['pack_id', 'confidence'],
          },
        },
        params: {
          type: 'object',
          description: 'Parameters for the first pack, using only its listed param keys and ranges.',
          additionalProperties: { type: ['boolean', 'number', 'string'] },
        },
        prefilled_answers: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              question_key: { type: 'string' },
              value: {
                anyOf: [
                  { type: 'boolean' }, { type: 'number' }, { type: 'string' },
                  { type: 'array', items: { type: 'string' } },
                ],
              },
              evidence: { type: 'string', description: 'Exact quote from the input that supports this answer.' },
            },
            required: ['question_key', 'value', 'evidence'],
          },
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact quotes from the input that support the pack choice.',
        },
        abstain: { type: 'boolean' },
      },
      required: ['packs', 'evidence', 'abstain'],
    },
  };
}

const RawProposalSchema = z.object({
  packs: z.array(z.object({
    pack_id: z.string(),
    confidence: z.number(),
    archetypes: z.array(z.string()).optional(),
    reason: z.string().optional(),
  }).passthrough()).default([]),
  params: z.record(z.string(), z.unknown()).optional(),
  prefilled_answers: z.array(z.object({
    question_key: z.string(),
    value: z.unknown(),
    evidence: z.string(),
  }).passthrough()).optional(),
  evidence: z.array(z.string()).default([]),
  abstain: z.boolean().default(false),
}).passthrough();

export interface AiRejection {
  kind: 'shape' | 'pack' | 'params' | 'answer' | 'evidence';
  detail: string;
}

export interface AiProposalResult {
  result: ClassifyResult;
  /** params for the top pack (defaults filled); defaults only if the AI's params failed */
  params: Record<string, ParamValue>;
  paramsFellBack: boolean;
  prefilledAnswers: Record<string, { value: AnswerValue; evidence: string }>;
  /** evidence quotes that were found verbatim in the input */
  evidence: string[];
  rejected: AiRejection[];
}

/** Cap applied when none of the model's quotes appear in the input. */
export const UNVERIFIED_CONFIDENCE_CAP = 0.5;

function inputCorpus(input: ClassifyInput): string {
  return normalizeForQuote(
    [input.description, input.companyIndustry, input.companyName, ...(input.fileHeaders ?? [])]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n'),
  );
}

function isVerbatim(quote: string, corpus: string): boolean {
  const q = normalizeForQuote(quote);
  return q.length >= 3 && corpus.includes(q);
}

/** Validate the model's raw tool input against the catalog and the user's own words. */
export function validateAiProposal(raw: unknown, input: ClassifyInput): AiProposalResult {
  const rejected: AiRejection[] = [];
  const empty = (): AiProposalResult => ({
    result: { candidates: [], abstain: true },
    params: {},
    paramsFellBack: false,
    prefilledAnswers: {},
    evidence: [],
    rejected,
  });

  const parsed = RawProposalSchema.safeParse(raw);
  if (!parsed.success) {
    rejected.push({ kind: 'shape', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return empty();
  }
  const p = parsed.data;
  const corpus = inputCorpus(input);

  const evidence: string[] = [];
  for (const q of p.evidence) {
    if (isVerbatim(q, corpus)) evidence.push(q.trim());
    else rejected.push({ kind: 'evidence', detail: `Not found in the input: "${q}"` });
  }

  const seen = new Set<string>();
  const candidates: PackCandidate[] = [];
  for (const pk of p.packs) {
    if (!isPackKey(pk.pack_id)) {
      rejected.push({ kind: 'pack', detail: `Unknown pack "${pk.pack_id}"` });
      continue;
    }
    if (seen.has(pk.pack_id)) continue;
    seen.add(pk.pack_id);
    let confidence = Math.max(0, Math.min(1, Number.isFinite(pk.confidence) ? pk.confidence : 0));
    const reasons = evidence.map((q) => `You wrote "${q}"`);
    if (evidence.length === 0) {
      confidence = Math.min(confidence, UNVERIFIED_CONFIDENCE_CAP);
      reasons.push('No quote from your input supports this yet');
    }
    if (pk.reason && pk.reason.trim()) reasons.push(pk.reason.trim().slice(0, 200));
    candidates.push({ packKey: pk.pack_id, confidence: Math.round(confidence * 1000) / 1000, reasons, source: 'ai' });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const top = candidates.slice(0, MAX_CANDIDATES);

  if (top.length === 0) {
    return { ...empty(), evidence };
  }

  const manifest = resolveManifest(top[0].packKey);
  const pc = checkParams(manifest, p.params);
  if (!pc.ok) for (const i of pc.issues) rejected.push({ kind: 'params', detail: i });

  const prefilledAnswers: AiProposalResult['prefilledAnswers'] = {};
  for (const a of p.prefilled_answers ?? []) {
    const q = manifest.questions.find((x) => x.key === a.question_key);
    if (!q) { rejected.push({ kind: 'answer', detail: `Unknown question "${a.question_key}" for ${manifest.key}` }); continue; }
    if (!isValidAnswer(q, a.value)) { rejected.push({ kind: 'answer', detail: `Invalid value for "${q.key}": ${JSON.stringify(a.value)}` }); continue; }
    if (!isVerbatim(a.evidence, corpus)) { rejected.push({ kind: 'answer', detail: `Evidence for "${q.key}" is not in the input: "${a.evidence}"` }); continue; }
    prefilledAnswers[q.key] = { value: a.value as AnswerValue, evidence: a.evidence.trim() };
  }

  return {
    result: { candidates: top, abstain: p.abstain === true },
    params: pc.params,
    paramsFellBack: !pc.ok,
    prefilledAnswers,
    evidence,
    rejected,
  };
}

/**
 * Combine rules and AI. A picked tile always wins. Otherwise the AI order wins unless the rules
 * are confident (≥ 0.85) and the AI is not (< 0.6). Packs both sides found are marked "merged".
 */
export function mergeAiAndRules(rules: ClassifyResult, ai: ClassifyResult | AiProposalResult): ClassifyResult {
  const aiRes: ClassifyResult = 'result' in ai ? ai.result : ai;
  const rTop = rules.candidates[0];
  if (rTop?.source === 'tile') return rules;
  if (aiRes.abstain || aiRes.candidates.length === 0) return rules;
  if (rules.candidates.length === 0) return { candidates: aiRes.candidates.slice(0, MAX_CANDIDATES), abstain: false };

  const aTop = aiRes.candidates[0];
  const rulesWin = !rules.abstain && rTop.confidence >= 0.85 && aTop.confidence < 0.6;
  const [primary, secondary] = rulesWin ? [rules.candidates, aiRes.candidates] : [aiRes.candidates, rules.candidates];

  const out: PackCandidate[] = primary.map((c) => {
    const other = secondary.find((s) => s.packKey === c.packKey);
    if (!other) return { ...c, reasons: [...c.reasons] };
    return {
      packKey: c.packKey,
      confidence: c.confidence,
      reasons: [...new Set([...c.reasons, ...other.reasons])],
      source: 'merged',
    };
  });
  for (const s of secondary) if (!out.some((c) => c.packKey === s.packKey)) out.push({ ...s, reasons: [...s.reasons] });
  return { candidates: out.slice(0, MAX_CANDIDATES), abstain: false };
}
