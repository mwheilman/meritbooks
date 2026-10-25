/**
 * Source detection + deterministic column mapping (PLT-67). Order of trust:
 *   user choice (1.0) → saved mapping for this source (1.0) → the adapter's field map (0.97) →
 *   exact generic alias (0.92; 0.8 for one-word generic headers) → fuzzy containment (0.65) →
 *   value sniff for required / contact columns (0.5).
 * Only columns under UNSURE_BELOW (and required fields with no column) are shown to the user, at
 * most three. The AI hook (./ai-hook.ts) may add 0.6 guesses for leftovers when AI is running. Pure.
 */
import { normHeader } from '../onboarding/import/automap';
import { parseDate, parseMoneyToCents } from '../onboarding/import/values';
import { ADAPTERS, recipeFor } from './adapters';
import { ENTITY_DEFS } from './fields';
import type {
  AdapterEntity, ColumnMap, Detection, ImportEntity, SavedMapping, SourceSystem, TargetField, UnsureColumn,
} from './types';
import { IMPORT_ENTITIES } from './types';

export const UNSURE_BELOW = 0.8;
export const MAX_UNSURE = 3;

const GENERIC = new Set(['name', 'type', 'total', 'amount', 'date', 'id', 'no', 'number', 'status', 'stage', 'client', 'company', 'address',
  'start', 'contract', 'customer', 'job', 'project', 'title', 'category', 'description', 'created', 'price', 'cost', 'balance', 'phone',
  'email', 'line', 'unit', 'item', 'location', 'site', 'to', 'from', 'end', 'year', 'list', 'po', 'co', 'ro', 'bin', 'qty']);

const words = (s: string) => s.split(' ').filter(Boolean);
const has = (header: string, alias: string) => ` ${header} `.includes(` ${alias} `);

/** Stable signature of a header row (saved mappings re-apply when it matches). */
export function headerSignature(headers: string[]): string {
  const s = [...new Set(headers.map(normHeader).filter(Boolean))].sort().join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${headers.length}:${(h >>> 0).toString(16)}`;
}

// ------------------------------------------------------------------ header row

let KNOWN: Set<string> | null = null;
function knownHeaders(): Set<string> {
  if (KNOWN) return KNOWN;
  const s = new Set<string>();
  for (const a of ADAPTERS) for (const e of a.entities) for (const k of Object.keys(e.columns)) s.add(k);
  for (const e of IMPORT_ENTITIES) for (const fd of ENTITY_DEFS[e].fields) for (const al of fd.aliases) s.add(al);
  KNOWN = s;
  return s;
}

/** 0-based index of the real header row (exports put a title block above the table). */
export function findHeaderRow(grid: string[][], scan = 15): number {
  const known = knownHeaders();
  let best = -1;
  let bestHits = 1;
  for (let r = 0; r < Math.min(scan, grid.length); r++) {
    const hits = (grid[r] ?? []).filter((c) => known.has(normHeader(c))).length;
    if (hits > bestHits) { best = r; bestHits = hits; }
  }
  if (best >= 0) return best;
  const wide = grid.findIndex((row) => row.filter((c) => c.trim() !== '').length >= 2);
  return wide >= 0 ? wide : 0;
}

// ------------------------------------------------------------------ detection

const ENTITY_HINTS: Partial<Record<ImportEntity, string[]>> = {
  customer: ['customer', 'client', 'contact'], vendor: ['vendor', 'sub', 'supplier', 'directory'], job: ['job', 'project', 'wip', 'contract'],
  budget: ['budget'], sov_line: ['sov', 'scheduleofvalues', 'g703'], commitment: ['po', 'commitment', 'purchaseorder', 'subcontract'],
  change_order: ['changeorder', 'co'], selection: ['selection'], file: ['file', 'document', 'photo'], equipment: ['equipment'],
  service_history: ['history', 'completed'], open_ar: ['ar', 'receivable', 'invoice', 'debtor'], agreement: ['membership', 'agreement', 'plan', 'contract', 'recurring'],
  unit: ['unit', 'wholegood', 'inventory'], rental_unit: ['rentalfleet', 'fleet'], part: ['part'], repair_order: ['ro', 'repairorder'],
  special_order: ['specialorder'], warranty_claim: ['warranty', 'claim'], rental_contract: ['rentalcontract'], employee: ['employee', 'technician', 'team', 'staff'],
  site: ['location', 'site', 'propert'], cost_item: ['pricebook', 'catalog', 'item', 'product', 'service'], deposit: ['deposit'],
};

function scoreRecipe(r: AdapterEntity, headers: Set<string>): number {
  const sig = r.signature.length ? r.signature.filter((h) => headers.has(h)).length / r.signature.length : 0;
  const known = Object.keys(r.columns);
  const cover = headers.size ? [...headers].filter((h) => known.includes(h)).length / headers.size : 0;
  return 0.7 * sig + 0.3 * cover;
}

function genericEntityScore(entity: ImportEntity, headers: Set<string>): number {
  const fields = ENTITY_DEFS[entity].fields;
  if (fields.length === 0) return 0;
  let hits = 0;
  let reqHit = 0;
  const required = fields.filter((x) => x.required);
  for (const fd of fields) {
    const hit = fd.aliases.some((a) => headers.has(a) && !GENERIC.has(a)) || fd.aliases.some((a) => headers.has(a));
    if (hit) { hits += 1; if (fd.required) reqHit += 1; }
  }
  const reqFrac = required.length ? reqHit / required.length : 1;
  return Math.min(1, (hits / Math.min(fields.length, 8)) * 0.6 + reqFrac * 0.4);
}

/** Which tool exported this file, and what is in it. */
export function detectSource(headers: string[], fileName = '', hint?: { source?: SourceSystem | null; entity?: ImportEntity | null }): Detection {
  const H = new Set(headers.map(normHeader).filter(Boolean));
  const file = fileName.toLowerCase().replace(/[^a-z]/g, '');
  const scored: { source: SourceSystem; entity: ImportEntity; confidence: number; reasons: string[] }[] = [];
  for (const a of ADAPTERS) {
    const named = a.fileHints.some((h) => h.length >= 3 && file.includes(h.replace(/[^a-z]/g, '')));
    for (const r of a.entities) {
      let s = scoreRecipe(r, H);
      const reasons: string[] = [];
      const sigHits = r.signature.filter((h) => H.has(h));
      if (sigHits.length) reasons.push(`${a.name} ${r.label.toLowerCase()} columns: ${sigHits.slice(0, 4).join(', ')}`);
      if (named) { s += 0.15; reasons.push(`file name says ${a.name}`); }
      if ((ENTITY_HINTS[r.entity] ?? []).some((h) => file.includes(h))) s += 0.05;
      if (hint?.source === a.id) s += 0.2;
      if (hint?.entity === r.entity) s += 0.2;
      scored.push({ source: a.id, entity: r.entity, confidence: Math.min(1, s), reasons });
    }
  }
  scored.sort((x, y) => y.confidence - x.confidence);
  const pool = hint?.entity ? scored.filter((x) => x.entity === hint.entity) : scored;
  const best = pool[0];
  if (best && best.confidence >= 0.6) {
    return { ...best, confidence: Math.round(best.confidence * 100) / 100, alternatives: scored.slice(1, 4).map(({ source, entity, confidence }) => ({ source, entity, confidence: Math.round(confidence * 100) / 100 })) };
  }
  // a spreadsheet we don't recognize: guess the entity from generic column names
  const generic = IMPORT_ENTITIES.map((e) => ({ e, s: genericEntityScore(e, H) + (hint?.entity === e ? 0.5 : 0) + ((ENTITY_HINTS[e] ?? []).some((h) => file.includes(h)) ? 0.1 : 0) }))
    .sort((x, y) => y.s - x.s);
  const source: SourceSystem = hint?.source ?? 'CSV';
  const entity = hint?.entity ?? generic[0]?.e ?? 'job';
  return {
    source, entity, confidence: Math.round(Math.min(0.59, generic[0]?.s ?? 0) * 100) / 100,
    reasons: [hint?.entity ? 'you picked what is in the file' : `column names look like ${ENTITY_DEFS[entity].plural}`],
    alternatives: scored.slice(0, 3).map(({ source: s, entity: en, confidence }) => ({ source: s, entity: en, confidence: Math.round(confidence * 100) / 100 })),
  };
}

// ------------------------------------------------------------------ mapping

export interface MapInput {
  entity: ImportEntity;
  source: SourceSystem;
  headers: string[];
  /** header → first cells (value sniff) */
  sample?: Record<string, string[]>;
  saved?: SavedMapping | null;
  /** field → header (null = "don't use a column") — the user's choices win */
  overrides?: Record<string, string | null>;
  /** guesses from the AI hook (applied only to fields still unmapped) */
  ai?: ColumnMap;
}

function share(values: string[] | undefined, test: (v: string) => boolean): number {
  const filled = (values ?? []).filter((v) => v.trim() !== '');
  return filled.length ? filled.filter(test).length / filled.length : 0;
}

const SNIFF: Partial<Record<TargetField['type'], (v: string) => boolean>> = {
  money: (v) => /[$.,]/.test(v) && typeof parseMoneyToCents(v) === 'number' && !parseDate(v),
  date: (v) => /[/-]/.test(v) && parseDate(v) !== null,
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()),
  phone: (v) => (v.replace(/\D/g, '').length >= 10 && v.replace(/\D/g, '').length <= 11 && /[()\-\s.]/.test(v)),
};

export function mapColumns(input: MapInput): ColumnMap {
  const defs = ENTITY_DEFS[input.entity].fields;
  const keys = new Set(defs.map((d) => d.key));
  const norm = input.headers.map((raw) => ({ raw, n: normHeader(raw) }));
  const byNorm = new Map(norm.map((h) => [h.n, h.raw]));
  const used = new Set<string>();
  const out: ColumnMap = {};
  const take = (field: string, header: string, confidence: number, source: ColumnMap[string]['source']) => {
    if (out[field] || used.has(header) || !keys.has(field)) return;
    out[field] = { header, confidence, source };
    used.add(header);
  };
  const blocked = new Set<string>();
  const typeOf = new Map(defs.map((d) => [d.key, d.type]));
  // a header that only LOOKS right must also hold the right kind of values (dates in a % column → no)
  const fits = (field: string, header: string): boolean => {
    const t = typeOf.get(field);
    const test = t === 'money' || t === 'signed_money' ? (v: string) => typeof parseMoneyToCents(v) === 'number'
      : t === 'date' ? (v: string) => parseDate(v) !== null
      : t === 'percent' ? (v: string) => /^\s*\d+(\.\d+)?\s*%?\s*$/.test(v) && !parseDate(v)
      : t === 'int' ? (v: string) => /^\s*[\d,]+\s*$/.test(v)
      : null;
    if (!test) return true;
    const cells = (input.sample?.[header] ?? []).filter((v) => v.trim() !== '');
    return cells.length === 0 || share(cells, test) >= 0.5;
  };

  // 1) the user's choices
  for (const [field, header] of Object.entries(input.overrides ?? {})) {
    if (!keys.has(field)) continue;
    if (header === null) { blocked.add(field); continue; }
    if (input.headers.includes(header)) take(field, header, 1, 'user');
  }
  // 2) the mapping saved last time for this source + entity
  if (input.saved && input.saved.entity === input.entity) {
    for (const [field, header] of Object.entries(input.saved.mapping)) {
      if (!blocked.has(field) && input.headers.includes(header)) take(field, header, 1, 'saved');
    }
  }
  // 3) the adapter's field map
  const recipe = recipeFor(input.source, input.entity);
  if (recipe) {
    for (const h of norm) {
      const field = recipe.columns[h.n];
      if (field && !blocked.has(field)) take(field, h.raw, 0.97, 'adapter');
    }
  }
  // 4) exact generic aliases (field order, alias order = priority)
  for (const d of defs) {
    if (out[d.key] || blocked.has(d.key)) continue;
    for (const alias of d.aliases) {
      const raw = byNorm.get(alias);
      if (raw && !used.has(raw) && fits(d.key, raw)) { take(d.key, raw, GENERIC.has(alias) ? 0.8 : 0.92, 'alias'); break; }
    }
  }
  // 5) fuzzy: the header contains a multi-word (or long) alias
  for (const d of defs) {
    if (out[d.key] || blocked.has(d.key)) continue;
    for (const alias of d.aliases) {
      if (words(alias).length < 2 && alias.length < 6) continue;
      const hit = norm.find((h) => !used.has(h.raw) && has(h.n, alias) && fits(d.key, h.raw));
      if (hit) { take(d.key, hit.raw, 0.65, 'fuzzy'); break; }
    }
  }
  // 6) the AI's guesses for what is left
  for (const [field, m] of Object.entries(input.ai ?? {})) {
    if (!blocked.has(field) && input.headers.includes(m.header)) take(field, m.header, Math.min(m.confidence, 0.6), 'ai');
  }
  // 7) value sniff for required fields and contact columns
  for (const d of defs) {
    if (out[d.key] || blocked.has(d.key)) continue;
    const test = SNIFF[d.type];
    if (!test || !(d.required || d.type === 'email' || d.type === 'phone')) continue;
    const hit = norm.find((h) => !used.has(h.raw) && share(input.sample?.[h.raw], test) >= 0.8);
    if (hit) take(d.key, hit.raw, 0.5, 'values');
  }
  return out;
}

export function unmappedHeaders(headers: string[], mapping: ColumnMap): string[] {
  const used = new Set(Object.values(mapping).map((m) => m.header));
  return headers.filter((h) => !used.has(h));
}

/** The 0–3 columns worth a look: required fields with no column first, then the least sure. */
export function unsureColumns(entity: ImportEntity, mapping: ColumnMap, sample: Record<string, string[]>): UnsureColumn[] {
  const defs = ENTITY_DEFS[entity].fields;
  const out: UnsureColumn[] = [];
  for (const d of defs) {
    if (d.required && !mapping[d.key]) {
      out.push({ field: d.key, label: d.label, required: true, header: null, confidence: 0, samples: [], why: `We couldn't find a column for ${d.label.toLowerCase()}.` });
    }
  }
  const low = defs
    .filter((d) => mapping[d.key] && mapping[d.key]!.confidence < UNSURE_BELOW)
    .sort((a, b) => (mapping[a.key]!.confidence - mapping[b.key]!.confidence) || (Number(Boolean(b.required)) - Number(Boolean(a.required))));
  for (const d of low) {
    const m = mapping[d.key]!;
    out.push({
      field: d.key, label: d.label, required: Boolean(d.required), header: m.header, confidence: m.confidence,
      samples: (sample[m.header] ?? []).filter(Boolean).slice(0, 3),
      why: m.source === 'ai' ? 'Suggested by AI from the header and a few rows.' : m.source === 'values' ? 'Matched by what the cells look like.' : `"${m.header}" is close, not exact.`,
    });
  }
  return out.slice(0, MAX_UNSURE);
}

/** field → header, for saving / sending. */
export function plainMapping(mapping: ColumnMap): Record<string, string> {
  return Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v.header]));
}
