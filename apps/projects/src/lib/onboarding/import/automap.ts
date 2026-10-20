/**
 * Column auto-map for job lists exported from Buildertrend, JobTread, simPRO, Innergy,
 * RFMS, ServiceTitan or a spreadsheet. Rules only (aliases → fuzzy → value sniff);
 * ./ai-map.ts asks the model about the leftovers when AI is up. Pure.
 *
 * Confidence: exact vendor alias 0.95 (0.8 for one-word generic headers like "Name"),
 * fuzzy containment 0.65, value sniff 0.5, AI 0.6. Anything under LOW_CONFIDENCE is
 * shown to the user to confirm; everything else is applied silently.
 */
import { IMPORT_FIELDS, type ColumnMapping, type ImportField } from '../types';
import { parseDate, parseMoneyToCents } from './values';
import type { Grid } from './grid';

export const LOW_CONFIDENCE = 0.8;

export interface FieldDef {
  key: ImportField;
  label: string;
  required: boolean;
  /** normalized aliases, most specific first */
  aliases: string[];
  /** words that disqualify a header in the fuzzy pass */
  blockers: string[];
}

export function normHeader(s: string): string {
  return (s || '').toLowerCase().replace(/#/g, ' number ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const GENERIC = new Set(['name', 'type', 'total', 'amount', 'date', 'id', 'no', 'number', 'location', 'site', 'value', 'price', 'status', 'stage', 'client', 'company', 'address', 'start', 'contract', 'customer', 'job', 'project', 'title', 'category', 'description', 'created']);

export const FIELD_DEFS: FieldDef[] = [
  {
    key: 'name', label: 'Job name', required: true,
    aliases: ['job name', 'project name', 'job title', 'project title', 'work order name', 'order name', 'opportunity name', 'job', 'project', 'name', 'title', 'job description', 'description'],
    blockers: ['number', 'no', 'id', 'type', 'status', 'stage', 'date', 'customer', 'client', 'owner', 'manager', 'group', 'address', 'code', 'prefix', 'contact', 'email', 'phone'],
  },
  {
    key: 'external_id', label: 'Job number', required: false,
    aliases: ['job number', 'job no', 'job id', 'job code', 'project number', 'project no', 'project id', 'work order number', 'wo number', 'order number', 'order no', 'quote number', 'number', 'no', 'id'],
    blockers: ['phone', 'po', 'customer', 'client', 'invoice', 'tax', 'zip', 'license'],
  },
  {
    key: 'customer', label: 'Customer', required: false,
    aliases: ['customer name', 'client name', 'owner name', 'homeowner', 'customer', 'client', 'owner', 'account name', 'customer company', 'bill to', 'sold to', 'company', 'account'],
    blockers: ['phone', 'email', 'mail', 'fax', 'address', 'street', 'city', 'state', 'zip', 'postal', 'number', 'no', 'id', 'type', 'po', 'contact'],
  },
  {
    key: 'job_type', label: 'Job type', required: false,
    aliases: ['job type', 'project type', 'work type', 'service type', 'job category', 'job group', 'business unit', 'type', 'category', 'division', 'trade', 'department'],
    blockers: ['customer', 'client', 'payment', 'tax', 'contract type'],
  },
  {
    key: 'contract', label: 'Contract value', required: false,
    aliases: ['contract price', 'contract amount', 'contract value', 'revised contract amount', 'revised contract', 'contract total', 'total contract', 'sale price', 'selling price', 'total price', 'job total', 'order total', 'estimate total', 'total ex tax', 'total excl tax', 'total inc tax', 'contract', 'price', 'total', 'amount', 'value', 'revenue'],
    blockers: ['date', 'cost', 'paid', 'billed', 'balance', 'due', 'tax amount', 'margin', 'profit', 'hours', 'deposit', 'retainage', 'count'],
  },
  {
    key: 'start_date', label: 'Start date', required: false,
    aliases: ['start date', 'projected start', 'scheduled start', 'actual start', 'estimated start', 'job start', 'date issued', 'issue date', 'sold date', 'contract date', 'order date', 'created date', 'date created', 'start', 'created', 'date'],
    blockers: ['end', 'finish', 'completion', 'complete', 'due', 'close', 'modified', 'updated', 'invoice', 'paid'],
  },
  {
    key: 'status', label: 'Status', required: false,
    aliases: ['job status', 'project status', 'order status', 'job stage', 'status', 'stage', 'phase'],
    blockers: ['payment', 'invoice', 'permit', 'billing', 'state', 'tax'],
  },
  {
    key: 'site_address', label: 'Site address', required: false,
    aliases: ['job address', 'site address', 'jobsite address', 'job site address', 'service address', 'location address', 'street address', 'address line 1', 'address 1', 'job site', 'jobsite', 'address', 'street', 'site', 'location'],
    blockers: ['email', 'mail', 'billing', 'bill to', 'city', 'state', 'zip', 'postal', 'customer', 'owner', 'name', 'ip'],
  },
];

export const FIELD_LABELS: Record<ImportField, string> = Object.fromEntries(FIELD_DEFS.map((f) => [f.key, f.label])) as Record<ImportField, string>;

function words(s: string): string[] {
  return s.split(' ').filter(Boolean);
}

function containsPhrase(header: string, alias: string): boolean {
  return ` ${header} `.includes(` ${alias} `);
}

function blocked(header: string, def: FieldDef): boolean {
  return def.blockers.some((b) => containsPhrase(header, b));
}

function share(values: string[], test: (v: string) => boolean): number {
  const filled = values.filter((v) => v.trim() !== '');
  if (filled.length === 0) return 0;
  return filled.filter(test).length / filled.length;
}

/**
 * Map headers to import fields. `sample` (header → first few cells) powers the value
 * sniff for money and dates when no header matched.
 */
export function autoMapColumns(headers: string[], sample: Record<string, string[]> = {}): ColumnMapping {
  const norm = headers.map((h) => ({ raw: h, n: normHeader(h) }));
  const used = new Set<string>();
  const out: ColumnMapping = {};

  // 1) exact alias, field by field, alias order = priority
  for (const def of FIELD_DEFS) {
    for (const alias of def.aliases) {
      const hit = norm.find((h) => !used.has(h.raw) && h.n === alias);
      if (hit) {
        out[def.key] = { header: hit.raw, confidence: GENERIC.has(alias) ? 0.8 : 0.95, source: 'alias' };
        used.add(hit.raw);
        break;
      }
    }
  }

  // 2) fuzzy: the header contains a multi-word (or long) alias and no blocker word
  for (const def of FIELD_DEFS) {
    if (out[def.key]) continue;
    for (const alias of def.aliases) {
      if (words(alias).length < 2 && alias.length < 6) continue;
      const hit = norm.find((h) => !used.has(h.raw) && containsPhrase(h.n, alias) && !blocked(h.n.replace(alias, ' '), def));
      if (hit) {
        out[def.key] = { header: hit.raw, confidence: 0.65, source: 'fuzzy' };
        used.add(hit.raw);
        break;
      }
    }
  }

  // 3) values: an unclaimed column whose cells are mostly money / dates
  const free = () => norm.filter((h) => !used.has(h.raw) && (sample[h.raw]?.length ?? 0) > 0);
  if (!out.contract) {
    const hit = free().find((h) =>
      !blocked(h.n, FIELD_DEFS.find((d) => d.key === 'contract')!)
      && share(sample[h.raw], (v) => /[$.,]/.test(v) && typeof parseMoneyToCents(v) === 'number' && !parseDate(v)) >= 0.8);
    if (hit) { out.contract = { header: hit.raw, confidence: 0.5, source: 'values' }; used.add(hit.raw); }
  }
  if (!out.start_date) {
    const hit = free().find((h) =>
      !blocked(h.n, FIELD_DEFS.find((d) => d.key === 'start_date')!) && share(sample[h.raw], (v) => /[/-]/.test(v) && parseDate(v) !== null) >= 0.8);
    if (hit) { out.start_date = { header: hit.raw, confidence: 0.5, source: 'values' }; used.add(hit.raw); }
  }
  return out;
}

export function unmappedHeaders(headers: string[], mapping: ColumnMapping): string[] {
  const used = new Set(Object.values(mapping).map((m) => m!.header));
  return headers.filter((h) => !used.has(h));
}

export function unmappedFields(mapping: ColumnMapping): ImportField[] {
  return IMPORT_FIELDS.filter((f) => !mapping[f]);
}

/** Pick the real header row (exports put titles above the table). 0-based. */
export function detectHeaderRow(grid: Grid, scan = 15): number {
  const all = new Set(FIELD_DEFS.flatMap((d) => d.aliases));
  let best = -1;
  let bestHits = 1;
  for (let r = 0; r < Math.min(scan, grid.length); r++) {
    const hits = (grid[r] ?? []).filter((c) => all.has(normHeader(c))).length;
    if (hits > bestHits) { best = r; bestHits = hits; }
  }
  if (best >= 0) return best;
  const firstWide = grid.findIndex((r) => r.filter((c) => c.trim() !== '').length >= 2);
  return firstWide >= 0 ? firstWide : 0;
}

const VENDOR_SIGNS: { vendor: string; any: string[]; need: number }[] = [
  { vendor: 'Buildertrend', any: ['projected start', 'projected completion', 'job group', 'actual start', 'job prefix', 'owner name', 'contract price'], need: 2 },
  { vendor: 'simPRO', any: ['job no', 'date issued', 'total ex tax', 'total inc tax', 'site', 'stage', 'cost centre'], need: 2 },
  { vendor: 'JobTread', any: ['job number', 'customer name', 'location name', 'location address', 'job stage', 'price'], need: 3 },
  { vendor: 'Innergy', any: ['project number', 'project name', 'contract value', 'project manager', 'project status'], need: 3 },
  { vendor: 'RFMS', any: ['order number', 'salesperson', 'order total', 'customer po', 'order date', 'order status'], need: 3 },
  { vendor: 'ServiceTitan', any: ['business unit', 'job type', 'campaign', 'completed on', 'job status', 'technician'], need: 3 },
];

export function detectVendor(headers: string[], fileName = ''): string | null {
  const f = fileName.toLowerCase().replace(/[^a-z]/g, '');
  for (const v of VENDOR_SIGNS) if (f.includes(v.vendor.toLowerCase())) return v.vendor;
  const set = new Set(headers.map(normHeader));
  let best: { vendor: string; hits: number } | null = null;
  for (const v of VENDOR_SIGNS) {
    const hits = v.any.filter((a) => set.has(a)).length;
    if (hits >= v.need && (!best || hits > best.hits)) best = { vendor: v.vendor, hits };
  }
  return best?.vendor ?? null;
}
