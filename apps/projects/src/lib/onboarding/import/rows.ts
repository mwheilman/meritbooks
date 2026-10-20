/**
 * Mapped records → ImportRow[] ready for pm.create_project. Pure: no DB, so the
 * preview the user confirms is exactly what the commit route creates.
 */
import type { ColumnMapping, ImportRow } from '../types';
import { normName, normalizeStatus, parseDate, parseMoneyToCents } from './values';

export interface JobTypeOption {
  key: string;
  label: string;
  archetype: string;
}

const ARCHETYPE_WORDS: Record<string, string[]> = {
  field_service: ['service', 'repair', 'call', 'service call', 'demand', 'diagnostic', 'warranty'],
  recurring_service: ['maintenance', 'agreement', 'membership', 'tune up', 'pm', 'recurring', 'contract service'],
  project: ['project', 'install', 'installation', 'replacement', 'construction', 'remodel', 'new construction', 'build'],
  retail_order: ['order', 'retail', 'sale', 'sales'],
  eto: ['production', 'manufacture', 'shop', 'fabrication', 'custom'],
  engagement: ['design', 'consulting', 'engagement', 'retainer'],
  development: ['development', 'lot', 'land'],
  dealer_service: ['repair order', 'ro', 'pdi', 'warranty claim'],
};

const tokens = (s: string) => normName(s).split(' ').filter(Boolean);

/** The installed job type a source "type" cell means, else null. */
export function matchJobType(raw: string | null, options: JobTypeOption[]): JobTypeOption | null {
  if (!raw || options.length === 0) return null;
  const n = normName(raw);
  if (!n) return null;
  const exact = options.find((o) => normName(o.label) === n || o.key.replace(/_/g, ' ') === n);
  if (exact) return exact;
  const rt = new Set(tokens(raw));
  const byWords = options
    .map((o) => ({ o, hits: tokens(o.label).filter((w) => w.length > 2 && rt.has(w)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)[0];
  if (byWords) return byWords.o;
  for (const o of options) {
    const words = ARCHETYPE_WORDS[o.archetype] ?? [];
    if (words.some((w) => ` ${n} `.includes(` ${w} `))) return o;
  }
  return null;
}

export interface MapRowsContext {
  jobTypes: JobTypeOption[];
  defaultJobTypeKey: string;
}

/** Records (header → cell) + mapping → rows with issues flagged, duplicates marked. */
export function mapRecords(
  records: Record<string, string>[],
  rowNumbers: number[],
  mapping: ColumnMapping,
  ctx: MapRowsContext,
): ImportRow[] {
  const cell = (rec: Record<string, string>, f: keyof ColumnMapping): string => {
    const m = mapping[f];
    return m ? (rec[m.header] ?? '').trim() : '';
  };
  const seen = new Map<string, number>();
  return records.map((rec, i) => {
    const rowNumber = rowNumbers[i] ?? i + 2;
    const issues: string[] = [];
    const name = cell(rec, 'name');
    const externalId = cell(rec, 'external_id') || null;
    const customer = cell(rec, 'customer') || null;
    const jobTypeRaw = cell(rec, 'job_type') || null;
    const statusRaw = cell(rec, 'status') || null;
    const siteAddress = cell(rec, 'site_address') || null;

    const matched = matchJobType(jobTypeRaw, ctx.jobTypes);
    const jobTypeKey = matched?.key ?? ctx.defaultJobTypeKey;
    if (jobTypeRaw && !matched) issues.push(`"${jobTypeRaw}" isn't one of your job types; using the default`);

    let contractCents: number | null = null;
    const rawContract = cell(rec, 'contract');
    if (rawContract) {
      const c = parseMoneyToCents(rawContract);
      if (c === undefined) issues.push(`Contract "${rawContract}" isn't an amount; left blank`);
      else if (c !== null && c < 0) issues.push('Contract is negative; left blank');
      else contractCents = c;
    }

    let startDate: string | null = null;
    const rawStart = cell(rec, 'start_date');
    if (rawStart) {
      startDate = parseDate(rawStart);
      if (!startDate) issues.push(`Start date "${rawStart}" isn't a date we can read; left blank`);
    }

    const status = normalizeStatus(statusRaw);
    const finished = status === 'complete' || status === 'cancelled';

    let invalid = false;
    if (!name) { invalid = true; issues.unshift('No job name'); }
    const sourceRef = externalId ? `import:${normName(externalId) || externalId}` : `import:name:${normName(name)}`;
    const dupOf = seen.get(sourceRef);
    if (name && dupOf !== undefined) { invalid = true; issues.unshift(`Same job as row ${dupOf}`); }
    else if (name) seen.set(sourceRef, rowNumber);

    return {
      rowNumber, name: name.slice(0, 200), externalId, customer, jobTypeRaw, jobTypeKey, jobTypeMatched: Boolean(matched),
      contractCents, startDate, statusRaw, status, siteAddress, sourceRef, issues, finished, invalid,
    };
  });
}

/** Rows the commit should create: valid, and (by default) open work only. */
export function rowsToCreate(rows: ImportRow[], includeFinished: boolean): ImportRow[] {
  return rows.filter((r) => !r.invalid && (includeFinished || !r.finished));
}
