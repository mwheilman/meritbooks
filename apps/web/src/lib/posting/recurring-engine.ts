/**
 * Recurring journal-entry engine.
 *
 * Generates entries from recurring_templates: for each active template whose
 * next_run_date has arrived (catching up any missed periods up to asOf), posts a
 * JE from template_lines, advances next_run_date by the template frequency, and
 * stamps last_generated_at. If the template is_reversing, a flipped reversing
 * entry is posted on the first day of the following month (the accrual pattern).
 *
 * A period whose fiscal period is missing/closed is reported and the catch-up
 * stops there (it does not skip ahead), so nothing posts out of order.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type JournalEntryLineInput } from '../services/gl-posting';
import { PostingError } from './account-roles';

type DB = SupabaseClient;

interface TemplateLine {
  account_id: string;
  debit_cents: number;
  credit_cents: number;
  department_id?: string | null;
  class_id?: string | null;
  memo?: string | null;
}

interface TemplateRow {
  id: string;
  name: string;
  frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';
  start_date: string;
  end_date: string | null;
  next_run_date: string | null;
  is_reversing: boolean;
  location_id: string;
  template_lines: TemplateLine[];
}

function stepMonths(freq: TemplateRow['frequency']): number {
  return freq === 'MONTHLY' ? 1 : freq === 'QUARTERLY' ? 3 : 12;
}

function addMonthsToDate(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  // clamp day to the target month's length
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function firstOfNextMonth(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

export interface RecurringRunResult {
  asOf: string;
  templates_processed: number;
  entries_posted: number;
  errors: { template_id: string; run_date: string; error: string }[];
}

export async function runDueRecurring(db: DB, orgId: string, asOf: string): Promise<RecurringRunResult> {
  const { data, error } = await db
    .from('recurring_templates')
    .select('id, name, frequency, start_date, end_date, next_run_date, is_reversing, location_id, template_lines')
    .eq('org_id', orgId)
    .eq('is_active', true);
  if (error) throw new PostingError(error.message);

  const templates = (data ?? []) as TemplateRow[];
  const result: RecurringRunResult = { asOf, templates_processed: 0, entries_posted: 0, errors: [] };

  for (const t of templates) {
    result.templates_processed++;
    const lines = Array.isArray(t.template_lines) ? t.template_lines : [];
    if (lines.length < 2) {
      result.errors.push({ template_id: t.id, run_date: '-', error: 'template has fewer than 2 lines' });
      continue;
    }

    let runDate = t.next_run_date ?? t.start_date;
    let lastGenerated: string | null = null;

    // Catch up every due period through asOf.
    while (runDate <= asOf && (!t.end_date || runDate <= t.end_date)) {
      const jeLines: JournalEntryLineInput[] = lines.map((l) => ({
        account_id: l.account_id,
        debit_cents: l.debit_cents,
        credit_cents: l.credit_cents,
        location_id: t.location_id,
        department_id: l.department_id ?? undefined,
        class_id: l.class_id ?? undefined,
        memo: l.memo ?? undefined,
      }));

      const je = await postJournalEntry(db, {
        org_id: orgId,
        location_id: t.location_id,
        entry_date: runDate,
        entry_type: 'RECURRING',
        memo: t.name,
        source_module: 'RECURRING',
        source_id: t.id,
        created_by: null,
        lines: jeLines,
      });
      if (!je.success) {
        result.errors.push({ template_id: t.id, run_date: runDate, error: je.error ?? 'post failed' });
        break; // stop catch-up at the first failure (e.g. closed period)
      }
      result.entries_posted++;
      lastGenerated = runDate;

      // Optional reversing entry on the first of the next month.
      if (t.is_reversing) {
        const revDate = firstOfNextMonth(runDate);
        const rev = await postJournalEntry(db, {
          org_id: orgId,
          location_id: t.location_id,
          entry_date: revDate,
          entry_type: 'REVERSING',
          memo: `${t.name} (reversal)`,
          source_module: 'RECURRING',
          source_id: t.id,
          created_by: null,
          lines: jeLines.map((l) => ({ ...l, debit_cents: l.credit_cents, credit_cents: l.debit_cents })),
        });
        if (rev.success) result.entries_posted++;
        // a failed reversal (e.g. next period closed) is non-fatal; the accrual still posted
      }

      runDate = addMonthsToDate(runDate, stepMonths(t.frequency));
    }

    if (lastGenerated) {
      await db
        .from('recurring_templates')
        .update({ next_run_date: runDate, last_generated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', t.id);
    }
  }

  return result;
}
