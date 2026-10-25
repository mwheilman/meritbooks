/**
 * Mapped cells → typed, validated rows (the exact rows pm.import_stage stores and pm.import_commit
 * creates). Money is integer cents parsed from the text (never float math); dates are ISO; enums
 * fold synonyms; one external ref per record (re-importing it later is skipped by the 1121
 * import_refs ledger). Pure.
 */
import { normHeader } from '../onboarding/import/automap';
import { matchJobType } from '../onboarding/import/rows';
import { normName, parseDate, parseMoneyToCents } from '../onboarding/import/values';
import { ENTITY_DEFS } from './fields';
import type { CellValue, ColumnMap, ImportEntity, Issue, JobTypeChoice, StagedRow, TargetField, ValidationReport } from './types';

export interface NormalizeContext {
  entity: ImportEntity;
  jobTypes: JobTypeChoice[];
  /** bring open work only (finished / cancelled jobs are not created) */
  openOnly: boolean;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TRUE = new Set(['yes', 'y', 'true', 't', '1', 'x', 'primary']);
const FALSE = new Set(['no', 'n', 'false', 'f', '0', '']);

function enumValue(raw: string, d: TargetField): string | null {
  const n = normHeader(raw);
  if (!n) return null;
  for (const o of d.options ?? []) {
    if (normHeader(o.value) === n || o.synonyms.some((s) => s === n)) return o.value;
  }
  for (const o of d.options ?? []) {
    if (o.synonyms.some((s) => s.length > 2 && ` ${n} `.includes(` ${s} `))) return o.value;
  }
  return null;
}

/** "45%" / "45" / "0.45" → 0.45 (fraction, 6 places). */
export function parsePercent(raw: string): number | null {
  const s = raw.replace(/[%\s,]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  const frac = raw.includes('%') || n > 1 ? n / 100 : n;
  return frac > 1 ? null : Math.round(frac * 1_000_000) / 1_000_000;
}

function parseNumber(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Convert one cell. Returns [value, issue?]. */
export function convertCell(raw: string, d: TargetField): [CellValue, Issue | null] {
  const v = (raw ?? '').trim();
  if (v === '') return [null, d.required ? { level: 'error', field: d.key, message: `${d.label} is blank` } : null];
  switch (d.type) {
    case 'money':
    case 'signed_money': {
      const c = parseMoneyToCents(v);
      if (c === undefined || c === null) return [null, { level: d.required ? 'error' : 'warn', field: d.key, message: `${d.label} "${v}" isn't an amount${d.required ? '' : '; left blank'}` }];
      if (d.type === 'money' && c < 0) return [null, { level: d.required ? 'error' : 'warn', field: d.key, message: `${d.label} is negative${d.required ? '' : '; left blank'}` }];
      return [c, null];
    }
    case 'date': {
      const iso = parseDate(v);
      return iso ? [iso, null] : [null, { level: d.required ? 'error' : 'warn', field: d.key, message: `${d.label} "${v}" isn't a date we can read${d.required ? '' : '; left blank'}` }];
    }
    case 'int': {
      const n = parseNumber(v);
      if (n === null || !Number.isInteger(n) || n < 0) return [null, { level: d.required ? 'error' : 'warn', field: d.key, message: `${d.label} "${v}" isn't a whole number` }];
      return [n, null];
    }
    case 'number': {
      const n = parseNumber(v);
      return n === null ? [null, { level: 'warn', field: d.key, message: `${d.label} "${v}" isn't a number; left blank` }] : [n, null];
    }
    case 'percent': {
      const p = parsePercent(v);
      return p === null ? [null, { level: 'warn', field: d.key, message: `${d.label} "${v}" isn't a percent; left blank` }] : [p, null];
    }
    case 'email': {
      const e = v.toLowerCase().split(/[;,\s]+/).find((x) => EMAIL.test(x)) ?? null;
      return e ? [e.slice(0, 254), null] : [null, { level: 'warn', field: d.key, message: `"${v}" isn't an email address; left off` }];
    }
    case 'phone': {
      const first = v.split(/[;,/]| or /)[0]!.trim();
      const digits = first.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15 ? [first.slice(0, 40), null] : [null, { level: 'warn', field: d.key, message: `"${v}" isn't a phone number; left off` }];
    }
    case 'enum': {
      const e = enumValue(v, d);
      return e ? [e, null] : [null, { level: 'warn', field: d.key, message: `${d.label} "${v}" isn't one we know; left blank` }];
    }
    case 'bool': {
      const n = v.toLowerCase();
      if (TRUE.has(n)) return [true, null];
      if (FALSE.has(n)) return [false, null];
      return [null, { level: 'warn', field: d.key, message: `${d.label} "${v}" isn't yes or no` }];
    }
    default:
      return [v.slice(0, d.max ?? 500), null];
  }
}

const slugCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

function splitName(full: string): [string, string | null] {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return [parts[0]!, null];
  return [parts.slice(0, -1).join(' '), parts[parts.length - 1]!];
}

/** Entity rules after the cells are typed (derived keys, cross-field checks, the external ref). */
function finish(entity: ImportEntity, d: Record<string, CellValue>, issues: Issue[], ctx: NormalizeContext, rowNumber: number): string | null {
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
  const ref = s('external_ref');
  delete d.external_ref;
  switch (entity) {
    case 'customer': {
      if (!s('name') && (s('contact_first') || s('contact_last'))) d.name = [s('contact_first'), s('contact_last')].filter(Boolean).join(' ');
      if (!s('name')) issues.unshift({ level: 'error', field: 'name', message: 'No customer name' });
      return ref;
    }
    case 'vendor':
      if (!s('name')) issues.unshift({ level: 'error', field: 'name', message: 'No vendor name' });
      return ref;
    case 'contact':
      if (!s('customer_ref') && !s('customer_name') && !s('vendor_name')) issues.push({ level: 'error', message: 'Whose contact is this? No customer or vendor' });
      if (!s('first_name') && !s('last_name') && !s('email') && !s('phone')) issues.push({ level: 'error', message: 'A contact needs a name, email or phone' });
      return ref;
    case 'site':
      if (!s('customer_ref') && !s('customer_name')) issues.push({ level: 'error', message: 'No customer for this location' });
      return ref;
    case 'employee': {
      if (!s('name') && (s('first_name') || s('last_name'))) d.name = [s('first_name'), s('last_name')].filter(Boolean).join(' ');
      if (s('name') && !s('first_name')) { const [a, b] = splitName(s('name')!); d.first_name = a; if (b) d.last_name = b; }
      if (!s('name')) issues.unshift({ level: 'error', field: 'name', message: 'No name' });
      if (!s('email') && !s('phone')) issues.push({ level: 'warn', message: 'No email or mobile, so no invite can go out' });
      return ref ?? (s('email') ? `email:${s('email')}` : null);
    }
    case 'cost_item': {
      if (!s('code') && s('name')) { d.code = slugCode(s('name')!); issues.push({ level: 'warn', field: 'code', message: `No item code; used ${d.code as string}` }); }
      if (!s('code') && !s('name')) issues.unshift({ level: 'error', field: 'code', message: 'No item code or name' });
      if (typeof d.code === 'string') d.code = (d.code as string).toUpperCase().slice(0, 24);
      if (!d.kind) d.kind = n('task_hours') ? 'SERVICE' : 'MATERIAL';
      return typeof d.code === 'string' ? (d.code as string) : ref;
    }
    case 'job': {
      if (typeof d.status === 'string') d.status_raw = d.status;
      const statusRaw = d.status;
      if (!d.status) d.status = 'active';
      if (ctx.openOnly && (statusRaw === 'complete' || statusRaw === 'cancelled')) {
        issues.unshift({ level: 'error', field: 'status', message: `${statusRaw === 'complete' ? 'Finished' : 'Cancelled'} job; bringing open work only` });
      }
      const jt = matchJobType(s('job_type'), ctx.jobTypes);
      if (jt) d.job_type_key = jt.key;
      else if (s('job_type') && ctx.jobTypes.length) issues.push({ level: 'warn', field: 'job_type', message: `"${s('job_type')}" isn't one of your job types; using ${ctx.jobTypes[0]!.label}` });
      if (d.contract_cents == null && (n('original_contract_cents') !== null || n('approved_co_cents') !== null)) {
        d.contract_cents = (n('original_contract_cents') ?? 0) + (n('approved_co_cents') ?? 0);
      }
      if (d.original_contract_cents == null && n('contract_cents') !== null) d.original_contract_cents = n('contract_cents')! - (n('approved_co_cents') ?? 0);
      const contract = n('contract_cents');
      const billed = n('billed_to_date_cents');
      if (contract !== null && billed !== null && billed > contract) issues.push({ level: 'warn', field: 'billed_to_date_cents', message: 'Billed to date is more than the contract' });
      if ((n('cost_to_date_cents') ?? 0) > 0 && !n('estimated_cost_cents') && n('pct_complete') === null) {
        issues.push({ level: 'warn', field: 'estimated_cost_cents', message: 'Cost to date without an estimated cost; Books can’t compute earned revenue for it' });
      }
      if ((n('retainage_receivable_cents') ?? 0) > (billed ?? Number.MAX_SAFE_INTEGER)) issues.push({ level: 'warn', field: 'retainage_receivable_cents', message: 'Retainage held is more than billed to date' });
      if (!s('name')) issues.unshift({ level: 'error', field: 'name', message: 'No job name' });
      return ref ?? (s('name') ? `name:${normName(s('name')!)}` : null);
    }
    case 'budget':
      return `${s('job_ref') ?? ''}|${s('cost_code') ?? ''}|${normName(s('description') ?? '')}`.slice(0, 200);
    case 'sov_line':
      return `${s('job_ref') ?? ''}|${n('line_no') ?? `row${rowNumber}`}`.slice(0, 200);
    case 'agreement': {
      if (!d.billing_frequency) d.billing_frequency = 'MONTHLY';
      if (d.visits_per_term == null) d.visits_per_term = n('visits_remaining') ?? 0;
      if (d.visits_remaining == null) d.visits_remaining = 0;
      if ((n('visits_remaining') ?? 0) > (n('visits_per_term') ?? 0)) issues.push({ level: 'error', field: 'visits_remaining', message: 'More visits remaining than the plan includes' });
      if (d.price_cents == null) d.price_cents = 0;
      if (d.deferred_cents == null) { d.deferred_cents = 0; issues.push({ level: 'warn', field: 'deferred_cents', message: 'No deferred balance in the file; carried as $0' }); }
      if (s('starts_on') && s('ends_on') && s('ends_on')! <= s('starts_on')!) issues.push({ level: 'error', field: 'ends_on', message: 'The term ends before it starts' });
      return ref;
    }
    case 'unit':
    case 'rental_unit': {
      if (!d.condition) d.condition = entity === 'rental_unit' ? 'RENTAL' : 'NEW';
      if ((n('floor_balance_cents') ?? 0) > 0 && !s('floor_lender')) issues.push({ level: 'warn', field: 'floor_lender', message: 'Floor-plan balance without a lender' });
      if ((n('floor_balance_cents') ?? 0) > (n('cost_cents') ?? Number.MAX_SAFE_INTEGER)) issues.push({ level: 'warn', field: 'floor_balance_cents', message: 'Floor-plan balance is more than the unit cost' });
      return s('stock_number') ?? s('serial_number');
    }
    case 'part':
      return `${s('manufacturer') ? `${s('manufacturer')!.toUpperCase()}-` : ''}${(s('part_number') ?? '').toUpperCase()}` || ref;
    case 'open_ar':
      return ref ?? `${s('customer_ref') ?? s('customer_name') ?? ''}|${rowNumber}`;
    default:
      // numbers restart per job in most tools (CO 1, CO 2 on every job): scope the ref to its job
      return ref && s('job_ref') ? `${s('job_ref')}|${ref}` : ref;
  }
}

/** Records (header → cell) + mapping → staged rows, with in-file duplicates marked. */
export function normalizeRecords(records: Record<string, string>[], rowNumbers: number[], mapping: ColumnMap, ctx: NormalizeContext): StagedRow[] {
  const defs = ENTITY_DEFS[ctx.entity].fields;
  const seen = new Map<string, number>();
  const seenNames = new Map<string, number>();
  return records.map((rec, i) => {
    const rowNumber = rowNumbers[i] ?? i + 2;
    const data: Record<string, CellValue> = {};
    const issues: Issue[] = [];
    for (const d of defs) {
      const m = mapping[d.key];
      if (!m) continue;
      const [value, issue] = convertCell(rec[m.header] ?? '', d);
      if (issue) issues.push(issue);
      if (value !== null && value !== '') data[d.key] = value;
    }
    const ref = finish(ctx.entity, data, issues, ctx, rowNumber);
    for (const d of defs) {
      if (d.required && d.key !== 'external_ref' && (data[d.key] === undefined || data[d.key] === null) && !issues.some((x) => x.field === d.key)) {
        issues.push({ level: 'error', field: d.key, message: mapping[d.key] ? `${d.label} is blank` : `${d.label} has no column` });
      }
    }
    const external = ref ? ref.slice(0, 200) : null;
    if (external) {
      const dup = seen.get(external);
      if (dup !== undefined) issues.unshift({ level: 'error', message: `Same as row ${dup}` });
      else seen.set(external, rowNumber);
    } else if ((ctx.entity === 'customer' || ctx.entity === 'vendor') && typeof data.name === 'string') {
      const k = normName(data.name);
      const dup = seenNames.get(k);
      if (dup !== undefined) issues.push({ level: 'warn', message: `Same name as row ${dup}; both link to one record` });
      else seenNames.set(k, rowNumber);
    }
    const validation: StagedRow['validation'] = issues.some((x) => x.level === 'error') ? 'INVALID' : issues.length ? 'WARN' : 'VALID';
    return { row_number: rowNumber, external_ref: external, data, issues, validation };
  });
}

/** The validation report the preview shows. */
export function validationReport(entity: ImportEntity, rows: StagedRow[]): ValidationReport {
  const money = ENTITY_DEFS[entity].fields.filter((d) => d.type === 'money' || d.type === 'signed_money').map((d) => d.key);
  const byField: Record<string, number> = {};
  const groups = new Map<string, { message: string; count: number; rows: number[] }>();
  const totals: Record<string, number> = Object.fromEntries(money.map((k) => [k, 0]));
  let duplicates = 0;
  for (const r of rows) {
    for (const i of r.issues) {
      if (i.field) byField[i.field] = (byField[i.field] ?? 0) + 1;
      if (/^Same as row/.test(i.message)) duplicates += 1;
      const key = `${i.level}:${i.field ?? ''}:${i.message.replace(/"[^"]*"/g, '…').replace(/row \d+/, 'row …')}`;
      const g = groups.get(key) ?? { message: i.message, count: 0, rows: [] };
      g.count += 1;
      if (g.rows.length < 20) g.rows.push(r.row_number);
      groups.set(key, g);
    }
    if (r.validation === 'INVALID') continue;
    for (const k of money) if (typeof r.data[k] === 'number') totals[k]! += r.data[k] as number;
  }
  return {
    total: rows.length,
    valid: rows.filter((r) => r.validation === 'VALID').length,
    warn: rows.filter((r) => r.validation === 'WARN').length,
    invalid: rows.filter((r) => r.validation === 'INVALID').length,
    duplicates,
    byField,
    topIssues: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    totals,
  };
}
