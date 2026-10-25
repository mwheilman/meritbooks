export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { resRpc } from '@/lib/residential/rpc';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

export interface PursuitCard {
  id: string;
  name: string;
  address: string | null;
  stage: 'IDENTIFIED' | 'LOI' | 'UNDER_CONTRACT' | 'GO_NO_GO' | 'GO' | 'DEAD';
  product_type: string;
  contract_price_cents: number | null;
  pursuit_budget_cents: number | null;
  earnest_money_cents: number | null;
  earnest_refundable: boolean;
  pursuit_spent_cents: number;
  dd_expires_on: string | null;
  earnest_hard_on: string | null;
  closing_on: string | null;
  days_to_hard_date: number | null;
  dd_total: number;
  dd_done: number;
  job_id: string | null;
  open_risks: string[];
  dd: Array<{ id: string; kind: string; title: string; status: string; due_on: string | null; owner: string | null }>;
}

/** The pursuit pipeline (RED-03) with each site's DD checklist (RED-04) and open risks. */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['job', 'draw'], query: z.object({ company: Uuid }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  return resRpc<{ pursuits: PursuitCard[] }>(db, 'dev_pursuit_board', { p_location: query.company });
});

const Fields = z.object({
  name: Text(200).optional(), address: Text(500).nullish(), parcels: z.array(Text(60)).max(50).optional(), product_type: z.enum(['FOR_RENT', 'FOR_SALE', 'MIXED']).optional(),
  asking_price_cents: Cents.nullish(), contract_price_cents: Cents.nullish(), pursuit_budget_cents: Cents.nullish(), earnest_money_cents: Cents.nullish(),
  earnest_refundable: z.boolean().optional(), loi_on: Day.nullish(), contract_on: Day.nullish(), dd_expires_on: Day.nullish(), earnest_hard_on: Day.nullish(),
  closing_on: Day.nullish(), pursuit_job_id: Uuid.nullish(), owner_membership_id: Uuid.nullish(), notes: Text(4000).nullish(),
});
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('save'), companyId: Uuid, pursuitId: Uuid.nullish(), fields: Fields }),
  z.object({ op: z.literal('advance'), pursuitId: Uuid, stage: z.enum(['IDENTIFIED', 'LOI', 'UNDER_CONTRACT', 'GO_NO_GO']) }),
  z.object({ op: z.literal('seed_dd'), pursuitId: Uuid }),
  z.object({ op: z.literal('dd_item'), itemId: Uuid, fields: z.object({ status: z.enum(['NOT_STARTED', 'ORDERED', 'RECEIVED', 'REVIEWED', 'ISSUE', 'WAIVED']).optional(),
    owner_name: Text(200).nullish(), vendor_id: Uuid.nullish(), due_on: Day.nullish(), finding: Text(4000).nullish(), document_id: Uuid.nullish() }) }),
  z.object({ op: z.literal('kill'), pursuitId: Uuid, reason: Text(1000).min(1, 'Say why the deal died') }),
  z.object({ op: z.literal('go'), pursuitId: Uuid, jobId: Uuid }),
]);

export const POST = route({ access: { cap: 'projects.financials', action: 'edit' }, mask: ['job', 'draw'], body: Body }, async ({ db, body, tenant }) => {
  switch (body.op) {
    case 'save':
      assertCompany(tenant, body.companyId);
      return { pursuitId: await resRpc<string>(db, 'dev_save_pursuit', { p_location: body.companyId, p_pursuit: body.pursuitId ?? null, p_fields: body.fields }) };
    case 'advance': return resRpc(db, 'dev_advance_pursuit', { p_pursuit: body.pursuitId, p_stage: body.stage });
    case 'seed_dd': return { added: await resRpc<number>(db, 'dev_seed_dd', { p_pursuit: body.pursuitId }) };
    case 'dd_item': return { itemId: await resRpc<string>(db, 'dev_update_dd_item', { p_item: body.itemId, p_fields: body.fields }) };
    case 'kill': return resRpc(db, 'dev_kill_pursuit', { p_pursuit: body.pursuitId, p_reason: body.reason });
    case 'go': return resRpc(db, 'dev_go_pursuit', { p_pursuit: body.pursuitId, p_job: body.jobId });
  }
});
