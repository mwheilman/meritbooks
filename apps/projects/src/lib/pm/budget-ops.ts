import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { must } from '@/lib/api';
import { hasActiveContract } from './guarded';
import type { BudgetRow } from './types';

/** A budget of this job that is still a draft (lines are editable only on drafts). */
export async function draftBudget(db: SupabaseClient, jobId: string, budgetId: string): Promise<BudgetRow> {
  const b = must(
    await db.schema('pm').from('budgets').select('id, job_id, kind, version, status, label, as_of, created_at, updated_at').eq('id', budgetId).eq('job_id', jobId).maybeSingle(),
    'budget',
  ) as BudgetRow | null;
  if (!b) throw new HttpError(404, 'That budget was not found on this job.', 'NOT_FOUND');
  if (b.status !== 'DRAFT') throw new HttpError(422, 'This budget is approved. Start a revision to change it.', 'BUDGET_LOCKED');
  return b;
}

/**
 * After a budget is approved, tell Merit Books the new cost estimate — only when
 * Books is present and the job has an active contract (emit_job_progress needs one).
 * Samples and standalone workspaces are recorded, not sent, by the function itself.
 */
export async function emitBudgetRevised(db: SupabaseClient, jobId: string, booksPresent: boolean): Promise<'sent' | 'no_books' | 'no_contract'> {
  if (!booksPresent) return 'no_books';
  if (!(await hasActiveContract(db, jobId))) return 'no_contract';
  must(await db.schema('pm').rpc('emit_job_progress', { p_job: jobId, p_trigger: 'BUDGET_REVISED' }), 'emit progress');
  return 'sent';
}
