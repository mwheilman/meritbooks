import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rows } from '@/lib/pm/db';
import {
  SCHEDULE_COLS, UNIT_COLS,
  type DrawBudgetLineRow, type DrawDetailRow, type DrawLineRow, type DrawLineStatusRow, type DrawScheduleRow, type DrawScheduleStatusRow,
  type DrawSummaryRow, type EntitlementRow, type UnitRow,
} from './types';
import type { Where } from './field-queries';

const pm = (db: SupabaseClient) => db.schema('pm');

export interface DrawRevision {
  id: string;
  draw_budget_line_id: string;
  from_cents: number;
  to_cents: number;
  reason: string;
  created_at: string;
}

export interface DrawBundle {
  schedules: DrawScheduleRow[];
  status: DrawScheduleStatusRow[];
  lineStatus: DrawLineStatusRow[];
  budgetLines: DrawBudgetLineRow[];
  draws: DrawSummaryRow[];
  details: DrawDetailRow[];
  drawLines: DrawLineRow[];
  revisions: DrawRevision[];
}

const STATUS_COLS =
  'job_id, draw_schedule_id, lender_name, loan_number, status, loan_commitment_cents, equity_required_cents, loan_funded_cents, equity_contributed_cents, ' +
  'funded_draws, last_funded_on, original_budget_cents, revised_budget_cents, drawn_gross_cents, retainage_held_cents, cost_to_complete_cents, ' +
  'interest_reserve_cents, interest_reserve_used_cents, loan_remaining_cents, equity_remaining_cents, in_balance_gap_cents, ' +
  'interest_reserve_remaining_cents, monthly_interest_cents, interest_reserve_months, contingency_burn_ratio';

const SUMMARY_COLS =
  'job_id, draw_schedule_id, draw_id, draw_number, period_end, status, inspection_status, inspector_pct_complete, lines_requested_cents, requested_cents, ' +
  'approved_cents, retainage_held_cents, retainage_released_cents, equity_applied_cents, loan_expected_cents, funded_cents, submitted_at, approved_at, ' +
  'funded_at, funded_on, cycle_days, package_missing';

/** Loan budgets, the continuation sheet, the in-balance test and the draw register in scope. */
export async function loadDraws(db: SupabaseClient, w: Where): Promise<DrawBundle> {
  const empty: DrawBundle = { schedules: [], status: [], lineStatus: [], budgetLines: [], draws: [], details: [], drawLines: [], revisions: [] };
  if (!w.companyIds.length) return empty;
  const ids = [...w.companyIds];
  let sq = pm(db).from('v_draw_schedule_status').select(STATUS_COLS).in('location_id', ids);
  let lq = pm(db).from('v_draw_line_status')
    .select('job_id, draw_schedule_id, draw_budget_line_id, line_no, description, category, original_cents, revised_cents, drawn_cents, open_request_cents, remaining_cents, pct_drawn, retainage_held_cents')
    .in('location_id', ids);
  let dq = pm(db).from('v_draw_summary').select(SUMMARY_COLS).in('location_id', ids);
  if (w.jobId) {
    sq = sq.eq('job_id', w.jobId);
    lq = lq.eq('job_id', w.jobId);
    dq = dq.eq('job_id', w.jobId);
  }
  const [status, lineStatus, draws] = await Promise.all([
    rows<DrawScheduleStatusRow>(await sq.limit(200), 'draw schedules'),
    rows<DrawLineStatusRow>(await lq.order('line_no').limit(3000), 'continuation sheet'),
    rows<DrawSummaryRow>(await dq.order('draw_number', { ascending: false }).limit(600), 'draws'),
  ]);
  const scheduleIds = status.map((s) => s.draw_schedule_id);
  if (!scheduleIds.length) return { ...empty, status, lineStatus, draws };
  const openDrawIds = draws.filter((d) => d.status !== 'CANCELLED').map((d) => d.draw_id);
  const [schedules, budgetLines, details, drawLines, revisions] = await Promise.all([
    rows<DrawScheduleRow>(await pm(db).from('draw_schedules').select(SCHEDULE_COLS).in('id', scheduleIds), 'schedules'),
    rows<DrawBudgetLineRow>(await pm(db).from('draw_budget_lines').select('id, draw_schedule_id, line_no, description, category, original_cents, revised_cents, retainage_applies, sort').in('draw_schedule_id', scheduleIds).order('line_no'), 'loan budget lines'),
    openDrawIds.length
      ? rows<DrawDetailRow>(await pm(db).from('draws').select('id, inspected_on, inspector_name, inspection_notes, lender_approver_name, wire_ref, returned_reason, package, notes').in('id', openDrawIds.slice(0, 300)), 'draw details')
      : Promise.resolve([] as DrawDetailRow[]),
    openDrawIds.length
      ? rows<DrawLineRow>(await pm(db).from('draw_lines').select('id, draw_id, draw_budget_line_id, requested_cents, approved_cents, retainage_held_cents, retainage_released_cents, notes').in('draw_id', openDrawIds.slice(0, 300)), 'draw lines')
      : Promise.resolve([] as DrawLineRow[]),
    rows<DrawRevision>(await pm(db).from('draw_budget_revisions').select('id, draw_budget_line_id, from_cents, to_cents, reason, created_at').in('job_id', [...new Set(status.map((s) => s.job_id))]).order('created_at', { ascending: false }).limit(300), 'loan budget revisions'),
  ]);
  return { schedules, status, lineStatus, budgetLines, draws, details, drawLines, revisions };
}

export interface UnitBundle {
  units: UnitRow[];
  entitlements: Array<EntitlementRow & { reference_number: string | null; conditions: string | null }>;
}

/** Lots / units and entitlement milestones. pm.units has no company column: the caller filters by job. */
export async function loadUnits(db: SupabaseClient, w: Where, inScope: (jobId: string) => boolean): Promise<UnitBundle> {
  let uq = pm(db).from('v_units_masked').select(UNIT_COLS);
  if (w.jobId) uq = uq.eq('job_id', w.jobId);
  let eq = pm(db).from('v_entitlement_status').select('location_id, job_id, entitlement_id, unit_id, kind, name, authority, status, target_on, submitted_on, hearing_on, approved_on, expires_on, is_late, expiring_soon');
  if (w.companyIds.length) eq = eq.in('location_id', [...w.companyIds]);
  if (w.jobId) eq = eq.eq('job_id', w.jobId);
  const [units, ents] = await Promise.all([
    rows<UnitRow>(await uq.order('job_id').order('sort').order('unit_number').limit(3000), 'units'),
    rows<EntitlementRow>(await eq.order('target_on', { nullsFirst: false }).limit(1000), 'entitlements'),
  ]);
  const extra = ents.length
    ? rows<{ id: string; reference_number: string | null; conditions: string | null }>(await pm(db).from('entitlements').select('id, reference_number, conditions').in('id', ents.map((e) => e.entitlement_id).slice(0, 1000)), 'entitlement detail')
    : [];
  const byId = new Map(extra.map((x) => [x.id, x]));
  return {
    units: units.filter((u) => inScope(u.job_id)),
    entitlements: ents.map((e) => ({ ...e, reference_number: byId.get(e.entitlement_id)?.reference_number ?? null, conditions: byId.get(e.entitlement_id)?.conditions ?? null })),
  };
}
