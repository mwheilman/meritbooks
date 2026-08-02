/**
 * Recurring journal-entry templates — persistence + generate/approve/post.
 *
 * Storage (REPORTED, not reused): the existing `posting_schedules` rail cannot
 * hold a recurring JE — it carries a SINGLE `debit_account_id`/`credit_account_id`
 * pair (no room for a multi-line allocation), has no JSON column, and its
 * `schedule_type` CHECK does not admit a recurring-JE type. So this engine runs on
 * two minimal tables (SQL reported to the lead for a serialized migration):
 *
 *   - `recurring_je_templates` — the template: cadence, start/end, and the balanced
 *     line set in a `lines` jsonb (bigint cents).
 *   - `recurring_je_runs` — the per-period ledger and PROPOSED→POSTED review queue.
 *     `unique (template_id, period_year, period_month)` is the double-generate /
 *     double-post guarantor (the exact role `posting_schedule_runs` plays for
 *     prepaid amortization).
 *
 * Flow (canon §3 — AI/automation proposes, a human approves, the deterministic
 * engine posts): `generateDue` builds each due period's balanced entry and stores
 * it as a PROPOSED run (it NEVER posts). `approveRun` re-validates the balance and
 * posts through `postJournalEntry`, then flips the run to POSTED with its
 * gl_entry_id. Nothing here auto-posts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from '../services/gl-posting';
import {
  validateBalance,
  nextDuePeriods,
  nextOccurrence,
  buildEntryLines,
  type RecurringCadence,
  type RecurringJeLine,
  type RecurringJeTemplate,
} from './schedule';

type DB = SupabaseClient;

const TEMPLATES = 'recurring_je_templates';
const RUNS = 'recurring_je_runs';

export type TemplateStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type RunStatus = 'PROPOSED' | 'POSTED' | 'SKIPPED';

export class RecurringJeStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurringJeStoreError';
  }
}

export interface CreateTemplateInput {
  orgId: string;
  locationId: string;
  name: string;
  cadence: RecurringCadence;
  startDate: string;
  endDate?: string | null;
  entryType?: string;
  memo?: string | null;
  lines: RecurringJeLine[];
  createdBy?: string | null;
}

interface TemplateRow {
  id: string;
  org_id: string;
  location_id: string;
  name: string;
  cadence: RecurringCadence;
  start_date: string;
  end_date: string | null;
  entry_type: string;
  memo: string | null;
  lines: RecurringJeLine[];
  status: TemplateStatus;
  periods_generated: number;
  last_period: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  location_id: string;
  cadence: RecurringCadence;
  start_date: string;
  end_date: string | null;
  entry_type: string;
  memo: string | null;
  status: TemplateStatus;
  line_count: number;
  amount_per_period_cents: number;
  periods_generated: number;
  last_period: string | null;
  next_period: string | null;
  next_post_date: string | null;
  pending_count: number;
  lines: RecurringJeLine[];
}

function normalizeLines(lines: RecurringJeLine[]): RecurringJeLine[] {
  return lines.map((l) => ({
    account_id: l.account_id,
    debit_cents: Math.trunc(l.debit_cents),
    credit_cents: Math.trunc(l.credit_cents),
    location_id: l.location_id ?? null,
    department_id: l.department_id ?? null,
    class_id: l.class_id ?? null,
    memo: l.memo ?? null,
  }));
}

function asTemplate(row: Pick<TemplateRow, 'cadence' | 'start_date' | 'end_date' | 'lines'>): RecurringJeTemplate {
  return {
    cadence: row.cadence,
    startDate: row.start_date,
    endDate: row.end_date,
    lines: row.lines ?? [],
  };
}

/** Create a recurring JE template (validates the line set balances first). */
export async function createTemplate(db: DB, input: CreateTemplateInput): Promise<{ id: string }> {
  const lines = normalizeLines(input.lines);
  const balance = validateBalance(lines);
  if (!balance.ok) throw new RecurringJeStoreError(balance.error);
  if (!input.name.trim()) throw new RecurringJeStoreError('Give the template a name');
  if (input.endDate && input.endDate < input.startDate) {
    throw new RecurringJeStoreError('End date must be on or after the start date');
  }

  const { data, error } = await db
    .from(TEMPLATES)
    .insert({
      org_id: input.orgId,
      location_id: input.locationId,
      name: input.name.trim(),
      cadence: input.cadence,
      start_date: input.startDate,
      end_date: input.endDate ?? null,
      entry_type: input.entryType ?? 'ADJUSTING',
      memo: input.memo ?? null,
      lines,
      status: 'ACTIVE',
      created_by: input.createdBy ?? null,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new RecurringJeStoreError(`Failed to create template: ${error?.message ?? 'unknown'}`);
  }
  return { id: (data as { id: string }).id };
}

export interface UpdateTemplateInput {
  name?: string;
  cadence?: RecurringCadence;
  startDate?: string;
  endDate?: string | null;
  entryType?: string;
  memo?: string | null;
  lines?: RecurringJeLine[];
  status?: TemplateStatus;
}

/** Update a template (re-validates the line set balance when lines change). */
export async function updateTemplate(db: DB, id: string, patch: UpdateTemplateInput): Promise<void> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name != null) {
    if (!patch.name.trim()) throw new RecurringJeStoreError('Give the template a name');
    update.name = patch.name.trim();
  }
  if (patch.cadence != null) update.cadence = patch.cadence;
  if (patch.startDate != null) update.start_date = patch.startDate;
  if (patch.endDate !== undefined) update.end_date = patch.endDate;
  if (patch.entryType != null) update.entry_type = patch.entryType;
  if (patch.memo !== undefined) update.memo = patch.memo;
  if (patch.status != null) update.status = patch.status;
  if (patch.lines != null) {
    const lines = normalizeLines(patch.lines);
    const balance = validateBalance(lines);
    if (!balance.ok) throw new RecurringJeStoreError(balance.error);
    update.lines = lines;
  }

  const { error } = await db.from(TEMPLATES).update(update).eq('id', id);
  if (error) throw new RecurringJeStoreError(`Failed to update template: ${error.message}`);
}

/** List templates with per-period total, next run, and pending-proposed count. */
export async function listTemplates(db: DB): Promise<TemplateSummary[]> {
  const { data, error } = await db
    .from(TEMPLATES)
    .select(
      'id, name, location_id, cadence, start_date, end_date, entry_type, memo, lines, status, periods_generated, last_period, created_at',
    )
    .order('created_at', { ascending: false });
  if (error) throw new RecurringJeStoreError(error.message);

  const rows = (data ?? []) as TemplateRow[];
  if (rows.length === 0) return [];

  // Pending PROPOSED counts per template (single query).
  const pendingById = new Map<string, number>();
  try {
    const { data: runs } = await db
      .from(RUNS)
      .select('template_id, status')
      .in('template_id', rows.map((r) => r.id))
      .eq('status', 'PROPOSED');
    for (const run of (runs ?? []) as { template_id: string }[]) {
      pendingById.set(run.template_id, (pendingById.get(run.template_id) ?? 0) + 1);
    }
  } catch {
    /* pending count is cosmetic */
  }

  const today = new Date().toISOString().slice(0, 10);

  return rows.map((r) => {
    const lines = r.lines ?? [];
    const balance = validateBalance(lines);
    const amountPerPeriod = balance.ok ? balance.totalCents : 0;
    let nextPeriod: string | null = null;
    let nextPostDate: string | null = null;
    if (r.status === 'ACTIVE') {
      const from = r.last_period ? nextMonthAfter(r.last_period) : today;
      const occ = nextOccurrence(asTemplate(r), from);
      if (occ) {
        nextPeriod = occ.period;
        nextPostDate = occ.postDate;
      }
    }
    return {
      id: r.id,
      name: r.name,
      location_id: r.location_id,
      cadence: r.cadence,
      start_date: r.start_date,
      end_date: r.end_date,
      entry_type: r.entry_type,
      memo: r.memo,
      status: r.status,
      line_count: lines.length,
      amount_per_period_cents: amountPerPeriod,
      periods_generated: r.periods_generated ?? 0,
      last_period: r.last_period,
      next_period: nextPeriod,
      next_post_date: nextPostDate,
      pending_count: pendingById.get(r.id) ?? 0,
      lines,
    };
  });
}

/** 'YYYY-MM' → 'YYYY-MM-01' of the following month (a date the next occurrence can key off). */
function nextMonthAfter(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const base = y * 12 + (m - 1) + 1;
  const year = Math.floor(base / 12);
  const month = (base % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

// ─── generate → propose ──────────────────────────────────────────────────────

export interface ProposedRun {
  id: string;
  template_id: string;
  template_name: string;
  period: string;
  entry_date: string;
  amount_cents: number;
  lines: RecurringJeLine[];
}

export interface GenerateResult {
  asOf: string;
  templates_processed: number;
  proposed: ProposedRun[];
  skipped_existing: number;
  errors: { template_id: string; period: string; error: string }[];
}

/**
 * For each ACTIVE template, build every period that is due on/before `asOf` and
 * not already in the run ledger, and store it as a PROPOSED run for human review.
 * NEVER posts. Idempotent — the run unique index (and a pre-check) prevent a
 * duplicate proposal for a period. Pass `templateId` to generate one template.
 */
export async function generateDue(
  db: DB,
  orgId: string,
  opts: { asOf: string; templateId?: string },
): Promise<GenerateResult> {
  const { asOf, templateId } = opts;
  const result: GenerateResult = {
    asOf,
    templates_processed: 0,
    proposed: [],
    skipped_existing: 0,
    errors: [],
  };

  let query = db
    .from(TEMPLATES)
    .select('id, name, location_id, cadence, start_date, end_date, entry_type, memo, lines, status')
    .eq('status', 'ACTIVE');
  if (templateId) query = query.eq('id', templateId);

  const { data, error } = await query;
  if (error) throw new RecurringJeStoreError(error.message);
  const templates = (data ?? []) as TemplateRow[];

  for (const t of templates) {
    result.templates_processed++;

    const balance = validateBalance(t.lines ?? []);
    if (!balance.ok) {
      result.errors.push({ template_id: t.id, period: '-', error: balance.error });
      continue;
    }

    // Existing run keys (any status) — the double-generate guard.
    const generated = new Set<string>();
    try {
      const { data: runs } = await db
        .from(RUNS)
        .select('period_year, period_month')
        .eq('template_id', t.id);
      for (const run of (runs ?? []) as { period_year: number; period_month: number }[]) {
        generated.add(`${run.period_year}-${String(run.period_month).padStart(2, '0')}`);
      }
    } catch {
      /* if this fails the unique index still guards the insert below */
    }

    const due = nextDuePeriods(asTemplate(t), { asOf, generated });
    const lines = buildEntryLines(t.lines ?? [], { locationId: t.location_id });

    for (const p of due) {
      const { data: inserted, error: insErr } = await db
        .from(RUNS)
        .insert({
          org_id: orgId,
          template_id: t.id,
          period_year: p.year,
          period_month: p.month,
          entry_date: p.postDate,
          proposed_lines: lines,
          amount_cents: balance.totalCents,
          status: 'PROPOSED',
        })
        .select('id')
        .single();

      if (insErr) {
        // A unique-violation means a concurrent generate already proposed it.
        if (/duplicate|unique/i.test(insErr.message)) {
          result.skipped_existing++;
          continue;
        }
        result.errors.push({ template_id: t.id, period: p.period, error: insErr.message });
        continue;
      }

      result.proposed.push({
        id: (inserted as { id: string }).id,
        template_id: t.id,
        template_name: t.name,
        period: p.period,
        entry_date: p.postDate,
        amount_cents: balance.totalCents,
        lines,
      });
    }
  }

  return result;
}

// ─── review queue ────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  template_id: string;
  period_year: number;
  period_month: number;
  entry_date: string;
  proposed_lines: RecurringJeLine[];
  amount_cents: number;
  status: RunStatus;
  gl_entry_id: string | null;
  posted_at: string | null;
  created_at: string;
}

export interface ProposedRunDetail extends ProposedRun {
  status: RunStatus;
}

/** List PROPOSED runs (the review-and-post queue), newest first. */
export async function listProposedRuns(db: DB): Promise<ProposedRunDetail[]> {
  const { data, error } = await db
    .from(RUNS)
    .select('id, template_id, period_year, period_month, entry_date, proposed_lines, amount_cents, status, created_at')
    .eq('status', 'PROPOSED')
    .order('entry_date', { ascending: true });
  if (error) throw new RecurringJeStoreError(error.message);
  const rows = (data ?? []) as RunRow[];
  if (rows.length === 0) return [];

  const nameById = new Map<string, string>();
  try {
    const { data: tmpls } = await db
      .from(TEMPLATES)
      .select('id, name')
      .in('id', Array.from(new Set(rows.map((r) => r.template_id))));
    for (const t of (tmpls ?? []) as { id: string; name: string }[]) nameById.set(t.id, t.name);
  } catch {
    /* names are cosmetic */
  }

  return rows.map((r) => ({
    id: r.id,
    template_id: r.template_id,
    template_name: nameById.get(r.template_id) ?? 'Recurring entry',
    period: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
    entry_date: r.entry_date,
    amount_cents: Number(r.amount_cents),
    lines: r.proposed_lines ?? [],
    status: r.status,
  }));
}

export interface ApproveResult {
  success: boolean;
  entry_id?: string;
  entry_number?: string;
  error?: string;
}

/**
 * Approve a PROPOSED run: re-validate the snapshot balances, post it through the
 * deterministic engine (`postJournalEntry`), then flip the run to POSTED with its
 * gl_entry_id. The `(template_id, period)` unique row plus the PROPOSED→POSTED
 * status transition make a double post impossible. Never posts twice.
 */
export async function approveRun(db: DB, orgId: string, runId: string): Promise<ApproveResult> {
  const { data: run, error } = await db
    .from(RUNS)
    .select('id, template_id, period_year, period_month, entry_date, proposed_lines, amount_cents, status')
    .eq('id', runId)
    .maybeSingle();
  if (error) return { success: false, error: error.message };
  if (!run) return { success: false, error: 'Proposed entry not found' };
  const r = run as RunRow;
  if (r.status !== 'PROPOSED') return { success: false, error: `Entry is already ${r.status.toLowerCase()}` };

  const lines = r.proposed_lines ?? [];
  const balance = validateBalance(lines);
  if (!balance.ok) return { success: false, error: balance.error };

  // Template context (location + entry type + memo).
  const { data: tmpl } = await db
    .from(TEMPLATES)
    .select('id, name, location_id, entry_type, memo')
    .eq('id', r.template_id)
    .maybeSingle();
  const t = tmpl as Pick<TemplateRow, 'id' | 'name' | 'location_id' | 'entry_type' | 'memo'> | null;
  if (!t) return { success: false, error: 'Template not found' };

  const period = `${r.period_year}-${String(r.period_month).padStart(2, '0')}`;
  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: t.location_id,
    entry_date: r.entry_date,
    entry_type: t.entry_type || 'ADJUSTING',
    memo: t.memo ? `${t.memo} (${period})` : `${t.name} — recurring ${period}`,
    source_module: 'RECURRING_JE',
    source_id: t.id,
    created_by: null,
    lines: lines.map((l) => ({
      account_id: l.account_id,
      debit_cents: l.debit_cents,
      credit_cents: l.credit_cents,
      location_id: l.location_id ?? t.location_id,
      department_id: l.department_id ?? undefined,
      class_id: l.class_id ?? undefined,
      memo: l.memo ?? undefined,
    })),
  });

  if (!je.success) return { success: false, error: je.error ?? 'Post failed' };

  const { error: updErr } = await db
    .from(RUNS)
    .update({ status: 'POSTED', gl_entry_id: je.entry_id, posted_at: new Date().toISOString() })
    .eq('id', r.id)
    .eq('status', 'PROPOSED');
  if (updErr) {
    // The GL entry posted but we couldn't mark the run — surface it; the unique
    // index still blocks a second post for this period, and the entry exists.
    return { success: false, error: `Posted ${je.entry_number} but failed to record the run: ${updErr.message}` };
  }

  // Advance the template's generated counter / last period (best-effort).
  try {
    const { data: cur } = await db
      .from(TEMPLATES)
      .select('periods_generated, last_period, end_date, cadence, start_date')
      .eq('id', t.id)
      .maybeSingle();
    const c = cur as Pick<TemplateRow, 'periods_generated' | 'last_period' | 'end_date' | 'cadence' | 'start_date'> | null;
    if (c) {
      const lastPeriod = !c.last_period || period > c.last_period ? period : c.last_period;
      const patch: Record<string, unknown> = {
        periods_generated: (c.periods_generated ?? 0) + 1,
        last_period: lastPeriod,
        updated_at: new Date().toISOString(),
      };
      // Mark COMPLETED once we've posted the final occurrence before/at end_date.
      if (c.end_date) {
        const next = nextOccurrence(asTemplate({ ...c, lines: [] }), nextMonthAfter(lastPeriod));
        if (!next) patch.status = 'COMPLETED';
      }
      await db.from(TEMPLATES).update(patch).eq('id', t.id);
    }
  } catch {
    /* counter is advisory; the run ledger is the source of truth */
  }

  return { success: true, entry_id: je.entry_id, entry_number: je.entry_number };
}

/** Reject (skip) a PROPOSED run for a period so it will not be re-proposed. */
export async function rejectRun(db: DB, runId: string): Promise<{ success: boolean; error?: string }> {
  const { data: run, error } = await db.from(RUNS).select('id, status').eq('id', runId).maybeSingle();
  if (error) return { success: false, error: error.message };
  if (!run) return { success: false, error: 'Proposed entry not found' };
  if ((run as { status: RunStatus }).status !== 'PROPOSED') {
    return { success: false, error: 'Only proposed entries can be skipped' };
  }
  const { error: updErr } = await db.from(RUNS).update({ status: 'SKIPPED' }).eq('id', runId).eq('status', 'PROPOSED');
  if (updErr) return { success: false, error: updErr.message };
  return { success: true };
}
