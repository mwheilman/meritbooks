/**
 * Jobs / WIP import — PURE normalizers (no gateway, no I/O; unit-tested directly).
 *
 * Two degrade-safe entry points produce the SAME `ProposedJob[]` shape:
 *   • `normalizeWipCsvRows` — the deterministic CSV column-map importer with alias
 *     detection. This ALWAYS works with AI off (design spec §5 "degrade-safe").
 *   • `normalizeWipExtraction` — folds the WIP_EXTRACT model's loose JSON (whole
 *     dollars) into the same shape (cents), with per-field confidence.
 *
 * Because both funnel into one shape, re-enabling the AI key is a pure quality lift
 * with zero flow change — exactly the invariant the loan parser established.
 */

import type { ImportFieldDef } from '@/lib/import/definitions';
import { coerceValue } from '@/lib/import/csv';
import type { JobCostType, ProposedCostCode, ProposedJob } from './types';

const LOW_CONFIDENCE = 0.6;

/**
 * CSV columns a job-cost / WIP export commonly carries, with alias fragments so the
 * importer auto-maps a messy header row. Money fields are dollars→cents (coerce);
 * only job number + name are strictly required to seat a job.
 */
export const WIP_IMPORT_FIELDS: ImportFieldDef[] = [
  { key: 'job_number', label: 'Job Number', type: 'text', required: true, aliases: ['job', 'job #', 'job no', 'number', 'project', 'project number', 'contract', 'contract #', 'job code'], help: 'The job / contract number as it appears in your job-cost system.' },
  { key: 'job_name', label: 'Job Name', type: 'text', required: true, aliases: ['name', 'job name', 'description', 'project name', 'title'] },
  { key: 'customer_name', label: 'Customer', type: 'text', aliases: ['customer', 'client', 'owner', 'homeowner', 'bill to', 'account'] },
  { key: 'original_contract_cents', label: 'Original Contract', type: 'money', aliases: ['original contract', 'base contract', 'contract original', 'original'] },
  { key: 'change_orders_cents', label: 'Approved Change Orders', type: 'money', aliases: ['change orders', 'approved cos', 'co amount', 'approved change orders', 'cos', 'co'] },
  { key: 'contract_value_cents', label: 'Contract Value', type: 'money', aliases: ['contract value', 'contract amount', 'revised contract', 'total contract', 'contract price', 'current contract', 'contract'] },
  { key: 'estimated_cost_cents', label: 'Estimated Cost (EAC)', type: 'money', aliases: ['estimated cost', 'eac', 'total estimated cost', 'estimated total cost', 'cost budget', 'budget', 'budget cost', 'projected cost'] },
  { key: 'costs_to_date_cents', label: 'Costs to Date', type: 'money', aliases: ['costs to date', 'cost to date', 'ctd', 'actual cost', 'job cost to date', 'cost incurred', 'costs incurred', 'jtd cost'] },
  { key: 'billed_to_date_cents', label: 'Billed to Date', type: 'money', aliases: ['billed to date', 'billed', 'billings', 'billings to date', 'invoiced', 'invoiced to date', 'billed jtd'] },
  { key: 'retainage_receivable_cents', label: 'Retainage Receivable', type: 'money', aliases: ['retainage receivable', 'retention receivable', 'retainage held', 'retainage', 'retention'] },
  { key: 'retainage_payable_cents', label: 'Retainage Payable', type: 'money', aliases: ['retainage payable', 'retention payable', 'sub retainage', 'retainage withheld'] },
  { key: 'customer_deposits_cents', label: 'Customer Deposits', type: 'money', aliases: ['customer deposit', 'customer deposits', 'deposit', 'deposits', 'advance', 'prepaid by customer', 'unearned deposit'] },
  { key: 'pct_complete', label: 'Percent Complete', type: 'number', aliases: ['percent complete', 'pct complete', '% complete', 'completion', 'complete pct'] },
  { key: 'job_type', label: 'Job Type', type: 'text', aliases: ['job type', 'type', 'category', 'division'] },
];

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** A percent (0–100 or 0–1) → a fraction in [0,1], or null. */
export function toFraction(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[%\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  const frac = n > 1 ? n / 100 : n;
  return frac > 1 ? 1 : frac;
}

const COST_TYPES: ReadonlySet<JobCostType> = new Set(['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER']);

/** Map a free-form cost-code label/name onto one of the job budget buckets. */
export function mapCostType(raw: unknown): JobCostType | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (!s) return null;
  if (COST_TYPES.has(s as JobCostType)) return s as JobCostType;
  if (s.includes('LABOR') || s.includes('LABOUR') || s.includes('WAGE')) return 'LABOR';
  if (s.includes('MATERIAL')) return 'MATERIALS';
  if (s.includes('SUB') || s.includes('TRADE')) return 'SUBCONTRACTOR';
  if (s.includes('EQUIP') || s.includes('RENTAL') || s.includes('MACHIN')) return 'EQUIPMENT';
  return 'OTHER';
}

/** True when a required-for-WIP contract value can be derived from the job. */
export function effectiveContractCents(job: Pick<ProposedJob, 'contractValueCents' | 'originalContractCents' | 'approvedChangeOrdersCents'>): number | null {
  if (job.contractValueCents != null) return job.contractValueCents;
  const orig = job.originalContractCents;
  const co = job.approvedChangeOrdersCents;
  if (orig == null && co == null) return null;
  return (orig ?? 0) + (co ?? 0);
}

/** Assemble the low-confidence list from a deterministic (CSV) row. */
function csvLowConfidence(job: ProposedJob): string[] {
  const low: string[] = [];
  if (effectiveContractCents(job) == null) low.push('contractValueCents');
  if (job.estimatedCostCents == null) low.push('estimatedCostCents');
  if (job.costsToDateCents == null) low.push('costsToDateCents');
  if (job.billedToDateCents == null) low.push('billedToDateCents');
  return low;
}

/**
 * Deterministic CSV → ProposedJob[]. `mapping` maps each WIP_IMPORT_FIELDS key to a
 * CSV header (from `autoMap` or a human remap); rows are the parsed CSV objects.
 * Coercion reuses the shared money/date coercion (dollars→cents). Rows with no job
 * number are skipped (returned in `skipped`) — never silently miscounted.
 */
export function normalizeWipCsvRows(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
): { jobs: ProposedJob[]; skipped: { row: number; reason: string }[]; rowErrors: { row: number; message: string }[] } {
  const jobs: ProposedJob[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const rowErrors: { row: number; message: string }[] = [];

  rows.forEach((raw, i) => {
    const rowNum = i + 2; // account for the header row
    const rec: Record<string, string | number | boolean | null> = {};
    let ok = true;
    for (const field of WIP_IMPORT_FIELDS) {
      const header = mapping?.[field.key];
      const cell = header ? (raw[header] ?? '') : '';
      // Every field is coerced as OPTIONAL: a WIP row may omit deposits/retainage, and a
      // blank job number is a section/total row we SKIP (below) rather than error on.
      const optional: ImportFieldDef = { ...field, required: false };
      const res = coerceValue(cell, optional);
      if (!res.ok) { rowErrors.push({ row: rowNum, message: res.error ?? `${field.label} invalid` }); ok = false; continue; }
      rec[field.key] = res.value;
    }
    if (!ok) return;

    const jobNumber = String(rec.job_number ?? '').trim();
    const jobName = String(rec.job_name ?? '').trim();
    if (!jobNumber) { skipped.push({ row: rowNum, reason: 'No job number — skipped (blank or section row).' }); return; }
    if (!jobName) { skipped.push({ row: rowNum, reason: `Job ${jobNumber} has no name — skipped.` }); return; }

    const job: ProposedJob = {
      jobNumber,
      jobName,
      customerName: rec.customer_name ? String(rec.customer_name) : null,
      jobType: rec.job_type ? String(rec.job_type) : null,
      originalContractCents: num(rec.original_contract_cents),
      approvedChangeOrdersCents: num(rec.change_orders_cents),
      contractValueCents: num(rec.contract_value_cents),
      estimatedCostCents: num(rec.estimated_cost_cents),
      costsToDateCents: num(rec.costs_to_date_cents),
      billedToDateCents: num(rec.billed_to_date_cents),
      retainageReceivableCents: num(rec.retainage_receivable_cents),
      retainagePayableCents: num(rec.retainage_payable_cents),
      customerDepositsCents: num(rec.customer_deposits_cents),
      pctCompleteOverride: toFraction(rec.pct_complete),
      costCodes: [],
      confidence: {},
      lowConfidenceFields: [],
      source: 'heuristic',
    };
    // Deterministic import: every mapped, present field is fully trusted (1.0); the
    // low-confidence list flags load-bearing fields the file simply didn't carry.
    job.confidence = {
      contractValueCents: effectiveContractCents(job) != null ? 1 : 0,
      estimatedCostCents: job.estimatedCostCents != null ? 1 : 0,
      costsToDateCents: job.costsToDateCents != null ? 1 : 0,
      billedToDateCents: job.billedToDateCents != null ? 1 : 0,
    };
    job.lowConfidenceFields = csvLowConfidence(job);
    jobs.push(job);
  });

  return { jobs, skipped, rowErrors };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI extraction normalizer (whole dollars → cents). Same shape, degrade-safe.
// ─────────────────────────────────────────────────────────────────────────────

interface RawJob {
  job_number?: unknown;
  job_name?: unknown;
  customer_name?: unknown;
  job_type?: unknown;
  original_contract?: unknown;
  change_orders?: unknown;
  contract_value?: unknown;
  estimated_cost?: unknown;
  costs_to_date?: unknown;
  billed_to_date?: unknown;
  retainage_receivable?: unknown;
  retainage_payable?: unknown;
  customer_deposits?: unknown;
  pct_complete?: unknown;
  cost_codes?: unknown;
  snippet?: unknown;
  confidence?: unknown;
}

/** Whole-dollars value → cents, or null when undeterminable. Never throws. */
function dollarsToCentsOrNull(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const cleaned = typeof raw === 'string' ? raw.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1') : raw;
  const n = typeof cleaned === 'number' ? cleaned : Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function costCodesFrom(raw: unknown): ProposedCostCode[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedCostCode[] = [];
  for (const c of raw as Array<Record<string, unknown>>) {
    const code = typeof c?.code === 'string' ? c.code.trim() : '';
    const budget = dollarsToCentsOrNull(c?.budget ?? c?.estimated_cost ?? c?.amount);
    if (!code && budget == null) continue;
    out.push({
      code: code || (typeof c?.label === 'string' ? c.label.trim() : 'Uncoded'),
      label: typeof c?.label === 'string' ? c.label.trim() : null,
      costType: mapCostType(c?.cost_type ?? c?.type ?? c?.label ?? c?.code),
      budgetCents: budget ?? 0,
    });
  }
  return out;
}

/** Normalize ONE raw job object (from the model) into a ProposedJob. */
export function normalizeWipJob(raw: unknown): ProposedJob {
  const j = (raw ?? {}) as RawJob;
  const c = (j.confidence ?? {}) as Record<string, unknown>;

  const job: ProposedJob = {
    jobNumber: typeof j.job_number === 'string' ? j.job_number.trim() : String(j.job_number ?? '').trim(),
    jobName: typeof j.job_name === 'string' ? j.job_name.trim() : String(j.job_name ?? '').trim(),
    customerName: typeof j.customer_name === 'string' && j.customer_name.trim() ? j.customer_name.trim() : null,
    jobType: typeof j.job_type === 'string' && j.job_type.trim() ? j.job_type.trim() : null,
    originalContractCents: dollarsToCentsOrNull(j.original_contract),
    approvedChangeOrdersCents: dollarsToCentsOrNull(j.change_orders),
    contractValueCents: dollarsToCentsOrNull(j.contract_value),
    estimatedCostCents: dollarsToCentsOrNull(j.estimated_cost),
    costsToDateCents: dollarsToCentsOrNull(j.costs_to_date),
    billedToDateCents: dollarsToCentsOrNull(j.billed_to_date),
    retainageReceivableCents: dollarsToCentsOrNull(j.retainage_receivable),
    retainagePayableCents: dollarsToCentsOrNull(j.retainage_payable),
    customerDepositsCents: dollarsToCentsOrNull(j.customer_deposits),
    pctCompleteOverride: toFraction(j.pct_complete),
    costCodes: costCodesFrom(j.cost_codes),
    confidence: {
      contractValueCents: conf(c.contract_value ?? c.contract),
      estimatedCostCents: conf(c.estimated_cost ?? c.eac),
      costsToDateCents: conf(c.costs_to_date),
      billedToDateCents: conf(c.billed_to_date),
    },
    lowConfidenceFields: [],
    source: 'ai',
    snippet: typeof j.snippet === 'string' && j.snippet.trim() ? j.snippet.trim() : null,
  };

  const low: string[] = [];
  if (effectiveContractCents(job) == null || job.confidence.contractValueCents < LOW_CONFIDENCE) low.push('contractValueCents');
  if (job.estimatedCostCents == null || job.confidence.estimatedCostCents < LOW_CONFIDENCE) low.push('estimatedCostCents');
  if (job.costsToDateCents == null || job.confidence.costsToDateCents < LOW_CONFIDENCE) low.push('costsToDateCents');
  if (job.billedToDateCents == null || job.confidence.billedToDateCents < LOW_CONFIDENCE) low.push('billedToDateCents');
  job.lowConfidenceFields = Array.from(new Set(low));
  return job;
}

/**
 * Fold the model's loose JSON (`{ jobs: [...] }` or a bare array) into ProposedJob[].
 * Drops entries with neither a job number nor a name. Never throws.
 */
export function normalizeWipExtraction(raw: unknown): ProposedJob[] {
  const root = raw as { jobs?: unknown } | unknown[];
  const arr = Array.isArray(root) ? root : Array.isArray((root as { jobs?: unknown })?.jobs) ? (root as { jobs: unknown[] }).jobs : [];
  return (arr as unknown[])
    .map(normalizeWipJob)
    .filter((j) => j.jobNumber !== '' || j.jobName !== '');
}
