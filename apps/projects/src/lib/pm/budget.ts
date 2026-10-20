import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pm, rows } from './db';
import type { BudgetLineRow, BudgetRow, CostCodeRow } from './types';

const CC_COLS = 'id, location_id, job_id, parent_id, code, name, cost_type, role_hint, install_id, source_pack, sort, is_active';

export interface CostCodeFilter {
  /** Include the job's own codes alongside the company library. */
  jobId?: string;
  includeInactive?: boolean;
}

export async function listCostCodes(db: SupabaseClient, companyId: string, f: CostCodeFilter = {}): Promise<CostCodeRow[]> {
  let q = pm(db).from('cost_codes').select(CC_COLS).eq('location_id', companyId);
  q = f.jobId ? q.or(`job_id.is.null,job_id.eq.${f.jobId}`) : q.is('job_id', null);
  if (!f.includeInactive) q = q.eq('is_active', true);
  return rows<CostCodeRow>(await q.order('sort').order('code'), 'cost codes');
}

export interface BudgetBundle {
  budgets: BudgetRow[];
  lines: BudgetLineRow[];
  /** The budget whose lines the page shows: the open draft, else the effective one. */
  current: BudgetRow | null;
  /** What v_job_money counts: latest APPROVED REVISED, else latest non-superseded ORIGINAL. */
  effective: BudgetRow | null;
  original: BudgetRow | null;
  draft: BudgetRow | null;
}

export function pickBudgets(budgets: ReadonlyArray<BudgetRow>): Omit<BudgetBundle, 'budgets' | 'lines'> {
  const byVer = [...budgets].sort((a, b) => b.version - a.version);
  const original = byVer.find((b) => b.kind === 'ORIGINAL' && b.status !== 'SUPERSEDED') ?? null;
  const revised = byVer.find((b) => b.kind === 'REVISED' && b.status === 'APPROVED') ?? null;
  const draft = byVer.find((b) => b.status === 'DRAFT' && (b.kind === 'REVISED' || b.kind === 'ORIGINAL')) ?? null;
  const effective = revised ?? original;
  return { original, effective, draft, current: draft ?? effective };
}

export async function getBudget(db: SupabaseClient, jobId: string): Promise<BudgetBundle> {
  const budgets = rows<BudgetRow>(
    await pm(db).from('budgets').select('id, job_id, kind, version, status, label, as_of, created_at, updated_at').eq('job_id', jobId).order('kind').order('version'),
    'budgets',
  );
  const ids = budgets.map((b) => b.id);
  const lines = ids.length
    ? rows<BudgetLineRow>(
        await pm(db).from('budget_lines').select('id, budget_id, cost_code_id, description, amount_cents, sort').in('budget_id', ids).order('sort').order('id'),
        'budget lines',
      )
    : [];
  return { budgets, lines, ...pickBudgets(budgets) };
}
