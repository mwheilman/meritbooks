export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { resRpc } from '@/lib/residential/rpc';
import { Uuid } from '@/lib/residential/schemas';

export interface CompanyKpis {
  location_id: string;
  company: string | null;
  backlog_cents: number;
  backlog_months: number | null;
  sold_12m_cents: number;
  sales_target_cents: number | null;
  sold_vs_target_pct: number | null;
  close_rate: number | null;
  won_12m: number;
  lost_12m: number;
  open_ar_cents: number;
  cash_cents: number | null;
  jobs_at_risk: number;
  unbilled_work_cents: number;
  margin_by_pm: Array<{ pm: string; jobs: number; revised_contract_cents: number; projected_margin_cents: number; projected_margin_pct: number | null }>;
  margin_by_job_type: Array<{ job_type: string; jobs: number; revised_contract_cents: number; projected_margin_cents: number; projected_margin_pct: number | null }>;
  open_warranty_items: number;
  warranty_cost_12m_cents: number;
}
export interface OwnerDashboard { companies: CompanyKpis[]; total: Partial<CompanyKpis> & { close_rate: number | null }; as_of: string }

/** Owner dashboard (RES-123): per company and rolled up across every company the caller holds financials at. */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['job', 'billing', 'budget'], query: z.object({ company: Uuid.optional() }) }, async ({ db, query, tenant }) => {
  if (query.company) assertCompany(tenant, query.company);
  const d = await resRpc<OwnerDashboard>(db, 'res_owner_dashboard', { p_location: query.company ?? null });
  const atRisk = query.company ? await resRpc<{ jobs: Array<Record<string, unknown>>; negative: number }>(db, 'res_cash_positions', { p_location: query.company }) : null;
  return { ...d, cashPositions: atRisk };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('scan'), companyId: Uuid }),
  z.object({ op: z.literal('weekly_updates'), companyId: Uuid }),
]);

/** scan → the daily margin-fade / cash-negative scan now; weekly_updates → Friday's client-update drafts now. */
export const POST = route({ access: { cap: 'projects.financials', action: 'view' }, ops: { weekly_updates: { cap: 'projects.jobs', action: 'edit' } }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  if (body.op === 'scan') return resRpc(db, 'res_scan_job_health', { p_location: body.companyId });
  return { drafted: await resRpc<number>(db, 'res_draft_weekly_updates', { p_location: body.companyId }) };
});
