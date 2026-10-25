export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';

export interface CashPosition {
  job_id: string;
  books_available: boolean;
  cash_collected_cents: number;
  cost_incurred_cents: number;
  committed_open_cents: number;
  cash_position_cents: number;
  cash_after_commitments_cents: number;
  open_ar_cents: number;
  billed_to_date_cents: number;
  deposits_requested_cents: number;
  deposits_received_cents: number;
  deposit_coverage_pct: number | null;
  next_draw: { draw_number: number; period_end: string; status: string } | null;
  negative: boolean;
  why: string | null;
}
export interface MarginFade {
  available: boolean;
  sold_margin_pct: number | null;
  projected_margin_pct: number | null;
  fade_points: number | null;
  threshold_points: number;
  fading: boolean;
  revised_contract_cents: number;
  projected_final_cost_cents: number;
  pending_co_cents: number;
  moved_codes: Array<{ cost_code_id: string; code: string; name: string; budget_cents: number; forecast_cents: number; over_cents: number; actual_cents: number; change_order_on_code: boolean }>;
  missing_change_orders: number;
  field_cos_unpriced: number;
  why: string | null;
}

/** Job cash position (RES-84) and margin fade (RES-122), with the job's open alerts. Job financials only. */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['job', 'budget', 'billing', 'cost'] }, async ({ db, params }) => {
  const job = params.jobId!;
  const [cash, fade] = await Promise.all([
    resRpc<CashPosition>(db, 'res_job_cash_position', { p_job: job }),
    resRpc<MarginFade>(db, 'res_margin_fade', { p_job: job }),
  ]);
  const alerts = resWrote<Array<{ id: string; kind: string; status: string; raised_at: string; fade_points: number | null; cash_position_cents: number | null }>>(await pm(db).from('res_margin_alerts')
    .select('id, kind, status, raised_at, fade_points, cash_position_cents').eq('job_id', job).neq('status', 'CLEARED'));
  return { cash, fade, alerts };
});
