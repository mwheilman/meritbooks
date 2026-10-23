/**
 * Recurring-invoice engine.
 *
 * A `public.recurring_invoice_templates` row (migration 073) describes a customer
 * bill that repeats on a cadence. `generateDueRecurringInvoices` finds every
 * active template whose `next_run_date` has arrived, and for each one CREATES a
 * real invoice through the SHARED `createInvoice` core — the exact code a
 * hand-keyed invoice uses, so numbering, rev-rec treatment, and GL posting never
 * fork. It then advances `next_run_date` by the cadence, decrements
 * `occurrences_remaining`, stamps `last_generated_at` / `last_invoice_id`, and
 * deactivates the template once its end date or occurrence count is exhausted.
 *
 * CATCH-UP + IDEMPOTENCY. Like the JE recurring engine it mirrors, a run
 * generates every missed period from `next_run_date` up to `asOf` (in order), and
 * because it advances and persists `next_run_date` past `asOf`, re-running on the
 * same day is a no-op — the guard against double-generating a period is that
 * `next_run_date` has already moved forward. A createInvoice failure mid-catch-up
 * stops that template at the failed period (its `next_run_date` is left pointing
 * at the unposted period so the next run retries it) — nothing posts out of order.
 *
 * Each generated invoice also carries `source_ref = recurring:<template>:<run date>`
 * (UNIQUE per org, migration 173), so even a crash between creating the invoice and
 * advancing the template can never produce a second invoice for the same period: the
 * retry gets DUPLICATE_SOURCE, adopts the existing invoice and moves on.
 *
 * MODES (migration 184 `generate_mode`): DRAFT (create for review — no GL, no email),
 * POST (post AR), POST_AND_SEND (post AR + email). A person's "run now" uses the
 * template's own mode; the scheduler (`ar.recurring`) passes `decideMode`, which can
 * only ever make it STRICTER (the autonomy dial turns POST / POST_AND_SEND into DRAFT).
 *
 * The pure planners (`advanceRecurringDate`, `planRecurringRuns`) carry the
 * cadence + exhaustion math and are unit-tested without a database.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createInvoice } from '@/lib/invoices/create-invoice';
import { sendInvoiceById } from '@/lib/invoices/send-invoice';
import { writerFor } from '@/lib/db/scoped-writer';

export type RecurringFrequency =
  | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';

/** What a generated invoice becomes (migration 184 recurring_invoice_templates.generate_mode). */
export type RecurringGenerateMode = 'DRAFT' | 'POST' | 'POST_AND_SEND';

const MODE_RANK: Record<RecurringGenerateMode, number> = { DRAFT: 0, POST: 1, POST_AND_SEND: 2 };

/** The template's own mode: generate_mode, else the legacy auto_send flag. */
export function templateMode(t: { generate_mode?: string | null; auto_send: boolean }): RecurringGenerateMode {
  if (t.generate_mode === 'DRAFT' || t.generate_mode === 'POST' || t.generate_mode === 'POST_AND_SEND') return t.generate_mode;
  return t.auto_send ? 'POST_AND_SEND' : 'POST';
}

/** The stricter of two modes (a caller can only ever tighten what the template allows). */
export function stricterMode(a: RecurringGenerateMode, b: RecurringGenerateMode): RecurringGenerateMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

/** The idempotency key a generated invoice carries (invoices.source_ref, unique per org). */
export function recurringSourceRef(templateId: string, runDate: string): string {
  return `recurring:${templateId}:${runDate}`;
}

// ─── Pure date math ───────────────────────────────────────────────────

/** Add `n` days to a YYYY-MM-DD date in UTC (DST-safe). */
export function addDaysUTC(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Add `n` months to a YYYY-MM-DD date, clamping the day to the target month. */
export function addMonthsUTC(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Whole-months step for a month-based frequency. */
function monthsForFrequency(freq: RecurringFrequency): number | null {
  switch (freq) {
    case 'MONTHLY': return 1;
    case 'QUARTERLY': return 3;
    case 'SEMIANNUAL': return 6;
    case 'ANNUAL': return 12;
    default: return null; // week-based
  }
}

/**
 * Advance a run date by one cadence step: `interval_count` × the frequency unit.
 * WEEKLY/BIWEEKLY step in days (7 / 14); the rest step in clamped months.
 */
export function advanceRecurringDate(date: string, freq: RecurringFrequency, intervalCount = 1): string {
  const n = Math.max(1, Math.floor(intervalCount || 1));
  if (freq === 'WEEKLY') return addDaysUTC(date, 7 * n);
  if (freq === 'BIWEEKLY') return addDaysUTC(date, 14 * n);
  const months = monthsForFrequency(freq);
  return addMonthsUTC(date, (months ?? 1) * n);
}

// ─── Pure run planner (catch-up + exhaustion) ─────────────────────────

export interface RecurringPlanInput {
  frequency: RecurringFrequency;
  interval_count: number;
  start_date: string;
  next_run_date: string | null;
  end_date: string | null;
  occurrences_remaining: number | null;
  is_active: boolean;
}

export interface RecurringRunPlan {
  /** Ordered run dates due at/through `asOf` (each becomes one invoice). */
  runDates: string[];
  /** Where `next_run_date` lands after these runs. */
  nextRunDate: string;
  /** Remaining occurrences after these runs (null = unbounded). */
  occurrencesRemaining: number | null;
  /** True when the template should be deactivated (end/occurrences exhausted). */
  deactivate: boolean;
}

/**
 * Compute the run dates a template owes through `asOf`, plus the resulting
 * next_run_date / remaining-occurrences / deactivate flags. Pure — no DB, no clock.
 * `cap` bounds catch-up so a long-dormant template can't generate unboundedly.
 */
export function planRecurringRuns(t: RecurringPlanInput, asOf: string, cap = 120): RecurringRunPlan {
  let runDate = t.next_run_date ?? t.start_date;
  let occ = t.occurrences_remaining;
  const runDates: string[] = [];

  if (t.is_active) {
    while (
      runDate <= asOf &&
      (t.end_date === null || runDate <= t.end_date) &&
      (occ === null || occ > 0) &&
      runDates.length < cap
    ) {
      runDates.push(runDate);
      if (occ !== null) occ -= 1;
      runDate = advanceRecurringDate(runDate, t.frequency, t.interval_count);
    }
  }

  const occExhausted = occ !== null && occ <= 0;
  const endReached = t.end_date !== null && runDate > t.end_date;
  const deactivate = t.is_active && (occExhausted || endReached);

  return { runDates, nextRunDate: runDate, occurrencesRemaining: occ, deactivate };
}

// ─── Engine ───────────────────────────────────────────────────────────

interface TemplateRow {
  id: string;
  org_id: string;
  location_id: string | null;
  customer_id: string | null;
  name: string;
  frequency: RecurringFrequency;
  interval_count: number;
  start_date: string;
  next_run_date: string | null;
  end_date: string | null;
  occurrences_remaining: number | null;
  is_active: boolean;
  auto_send: boolean;
  generate_mode: string | null;
  template_data: TemplateData;
  last_invoice_id: string | null;
}

/** What `decideMode` is told about a template that has periods due. */
export interface RecurringDueTemplate {
  id: string;
  name: string;
  location_id: string;
  customer_id: string;
  /** The template's own mode (generate_mode / auto_send). */
  mode: RecurringGenerateMode;
  /** Invoices this run would create for the template. */
  runs: number;
  /** Their total (lines + tax) in cents — what the autonomy cap is compared against. */
  amountCents: number;
}

export interface TemplateLine {
  description: string;
  account_id: string;
  quantity?: number;
  unit_price_cents: number;
}

export interface TemplateData {
  lines?: TemplateLine[];
  memo?: string | null;
  tax_cents?: number;
  /** Net payment terms in days used to derive each invoice's due date. */
  terms?: number;
  job_id?: string | null;
  is_progress_bill?: boolean;
}

/** One period's invoice amount (Σ qty × unit price + tax), cents. Pure. */
export function templateRunAmountCents(d: TemplateData): number {
  const lines = Array.isArray(d.lines) ? d.lines : [];
  const sub = lines.reduce((s, l) => s + Math.round((l.quantity ?? 1) * Number(l.unit_price_cents ?? 0)), 0);
  return sub + Math.max(0, Math.round(Number(d.tax_cents ?? 0)));
}

export interface RecurringGenerateResult {
  asOf: string;
  templates_processed: number;
  invoices_created: number;
  /** Of invoices_created, how many were left as DRAFT for review. */
  invoices_drafted: number;
  invoices_sent: number;
  /** Periods whose invoice already existed (source_ref) — adopted, not duplicated. */
  already_generated: number;
  errors: { template_id: string; run_date: string; error: string }[];
  created: { template_id: string; invoice_id: string; invoice_number: string; run_date: string; mode: RecurringGenerateMode }[];
}

export interface RecurringGenerateOptions {
  templateId?: string;
  /**
   * Decide the mode for a template's due periods (the scheduler's autonomy gate). The
   * answer can only tighten the template's own mode (stricterMode). Default: the
   * template's own mode (a person pressed "run").
   */
  decideMode?: (t: RecurringDueTemplate) => Promise<RecurringGenerateMode>;
  /** Stop between templates when aborted (scheduler timeout). */
  signal?: AbortSignal;
}

/**
 * Generate every due recurring invoice for `orgId` as of `asOf` (YYYY-MM-DD,
 * defaults today UTC). Optionally scope to a single template (`templateId`) for a
 * "run this one now" action.
 */
export async function generateDueRecurringInvoices(
  supabase: SupabaseClient,
  orgId: string,
  asOf: string = new Date().toISOString().slice(0, 10),
  opts: RecurringGenerateOptions = {},
): Promise<RecurringGenerateResult> {
  const result: RecurringGenerateResult = {
    asOf, templates_processed: 0, invoices_created: 0, invoices_drafted: 0, invoices_sent: 0, already_generated: 0, errors: [], created: [],
  };

  let query = supabase
    .from('recurring_invoice_templates')
    .select('id, org_id, location_id, customer_id, name, frequency, interval_count, start_date, next_run_date, end_date, occurrences_remaining, is_active, auto_send, generate_mode, template_data, last_invoice_id')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .lte('next_run_date', asOf);
  if (opts.templateId) query = query.eq('id', opts.templateId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const templates = (data ?? []) as TemplateRow[];

  for (const t of templates) {
    if (opts.signal?.aborted) break;
    result.templates_processed++;

    const data073 = (t.template_data ?? {}) as TemplateData;
    const lines = Array.isArray(data073.lines) ? data073.lines : [];
    if (!t.location_id || !t.customer_id || lines.length === 0) {
      result.errors.push({ template_id: t.id, run_date: t.next_run_date ?? '-', error: 'template missing company, customer, or line items' });
      continue;
    }

    const plan = planRecurringRuns(t, asOf);
    if (plan.runDates.length === 0) continue;

    // Mode: the template's own, tightened by the caller (the scheduler's autonomy dial).
    const own = templateMode(t);
    let mode: RecurringGenerateMode = own;
    if (opts.decideMode) {
      try {
        mode = stricterMode(own, await opts.decideMode({
          id: t.id, name: t.name, location_id: t.location_id, customer_id: t.customer_id, mode: own,
          runs: plan.runDates.length, amountCents: templateRunAmountCents(data073) * plan.runDates.length,
        }));
      } catch (e) {
        // A gate that can't answer degrades SAFE: draft for review.
        console.warn('[recurring] mode decision failed; drafting for review', t.id, e instanceof Error ? e.message : e);
        mode = 'DRAFT';
      }
    }

    const netDays = Number.isFinite(data073.terms) ? Number(data073.terms) : 30;
    let occ = t.occurrences_remaining;
    let runDate = t.next_run_date ?? t.start_date;
    let lastInvoiceId: string | null = t.last_invoice_id;
    let failed = false;
    let advancedWithoutCreate = false;
    const createdThisTemplate: string[] = [];
    const postedThisTemplate: string[] = [];

    for (const rd of plan.runDates) {
      const outcome = await createInvoice(supabase, {
        orgId,
        actor: 'system',
        input: {
          location_id: t.location_id,
          customer_id: t.customer_id,
          job_id: data073.job_id ?? null,
          invoice_date: rd,
          due_date: addDaysUTC(rd, netDays),
          memo: data073.memo ?? t.name,
          tax_cents: data073.tax_cents ?? 0,
          is_progress_bill: data073.is_progress_bill ?? false,
          // POST / POST_AND_SEND: a committed obligation → real AR. DRAFT: created for a
          // person to review, post and send (no GL effect yet).
          post_to_gl: mode !== 'DRAFT',
          // One invoice per template + period, ever (unique per org, migration 173).
          source: { source_ref: recurringSourceRef(t.id, rd) },
          lines: lines.map((l) => ({
            description: l.description,
            account_id: l.account_id,
            quantity: l.quantity ?? 1,
            unit_price_cents: l.unit_price_cents,
          })),
        },
      });

      if (!outcome.ok && outcome.code === 'DUPLICATE_SOURCE') {
        // This period's invoice already exists (an earlier run created it but died
        // before advancing the template): adopt it, never create a second one.
        const { data: existing } = await supabase
          .from('invoices')
          .select('id')
          .eq('org_id', orgId)
          .eq('source_ref', recurringSourceRef(t.id, rd))
          .maybeSingle();
        result.already_generated++;
        lastInvoiceId = (existing as { id?: string } | null)?.id ?? lastInvoiceId;
        if (occ !== null) occ -= 1;
        runDate = advanceRecurringDate(rd, t.frequency, t.interval_count);
        advancedWithoutCreate = true;
        continue;
      }

      if (!outcome.ok) {
        // Stop this template's catch-up at the failed period; leave next_run_date
        // pointing at it so the next run retries. Nothing posts out of order.
        result.errors.push({ template_id: t.id, run_date: rd, error: outcome.error });
        runDate = rd;
        failed = true;
        break;
      }

      result.invoices_created++;
      if (mode === 'DRAFT' || !outcome.result.posted) result.invoices_drafted++;
      result.created.push({ template_id: t.id, invoice_id: outcome.result.invoice_id, invoice_number: outcome.result.invoice_number, run_date: rd, mode });
      createdThisTemplate.push(outcome.result.invoice_id);
      if (outcome.result.posted) postedThisTemplate.push(outcome.result.invoice_id);
      lastInvoiceId = outcome.result.invoice_id;
      if (occ !== null) occ -= 1;
      runDate = advanceRecurringDate(rd, t.frequency, t.interval_count);
    }

    // Persist advancement. On clean completion trust the planner's terminal state;
    // on failure keep the template active with next_run_date at the failed period.
    const nextRunDate = failed ? runDate : plan.nextRunDate;
    const occRemaining = failed ? occ : plan.occurrencesRemaining;
    const deactivate = !failed && plan.deactivate;

    if (createdThisTemplate.length > 0 || failed || advancedWithoutCreate) {
      // recurring_invoice_templates is SELECT-only for members (migration 172): the template
      // was read through the caller's client above (RLS proved org + client scope for a
      // member); the service role advances it, org pinned.
      await writerFor(supabase)
        .from('recurring_invoice_templates')
        .update({
          next_run_date: nextRunDate,
          occurrences_remaining: occRemaining,
          last_generated_at: createdThisTemplate.length > 0 ? new Date().toISOString() : undefined,
          last_invoice_id: lastInvoiceId,
          is_active: deactivate ? false : true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', t.id)
        .eq('org_id', orgId);
    }

    // Auto-send is a per-template autonomy dial (VIII.7 — no global "let it run").
    // Best-effort: a missing email provider or customer email never breaks the
    // generation; the invoice already exists as real AR for review.
    // Only posted invoices go out: one left DRAFT (a COA gap) waits for a person.
    if (mode === 'POST_AND_SEND' && postedThisTemplate.length > 0) {
      for (const invId of postedThisTemplate) {
        try {
          const sent = await sendInvoiceById(supabase, orgId, invId, 'system');
          if (sent.ok) result.invoices_sent++;
        } catch (e) {
          console.error('[recurring auto-send] failed', invId, e instanceof Error ? e.message : e);
        }
      }
    }
  }

  return result;
}

/** Initial next_run_date for a freshly-created template: its start date. */
export function initialNextRunDate(startDate: string): string {
  return startDate;
}
