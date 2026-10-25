export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { companyJobIds, inList, xcall, xrows } from '@/lib/dealer/rpc';
import { IsoDate, Qty, Text, Uuid } from '@/lib/dealer/schemas';

export interface HubRow {
  job_id: string;
  component_id: string;
  dsn_item_id: string;
  item_name: string;
  room: string;
  component_kind: string | null;
  description: string;
  vendor_id: string | null;
  sidemark: string | null;
  po_number: string | null;
  status: string;
  tracking_ref: string | null;
  received_condition: string | null;
  freight_claim_open: boolean | null;
  dates: Record<string, { on: string | null; done: boolean }>;
  next_due_on: string | null;
  bucket: 'OVERDUE' | 'TODAY' | 'THIS_WEEK' | 'LATER' | 'DONE' | 'UNSCHEDULED';
}

/** Every component across the studio's projects with its 8 dates and the next one due (no money). */
export const GET = route({ access: { cap: 'projects.selections', action: 'view' }, query: z.object({ company: Uuid, job: Uuid.optional() }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const jobs = query.job ? [query.job] : await companyJobIds(db, query.company);
  const rows = await xrows<HubRow>(db.schema('pm').from('v_dsn_procurement_hub').select('job_id, component_id, dsn_item_id, item_name, room, component_kind, description, vendor_id, sidemark, po_number, status, tracking_ref, received_condition, freight_claim_open, dates, next_due_on, bucket').in('job_id', inList(jobs)).order('next_due_on', { ascending: true, nullsFirst: false }).limit(2000), 'procurement hub');
  return { rows };
});

const DATE_KEYS = ['order', 'ship', 'delivery', 'install', 'client_deposit', 'vendor_deposit', 'client_balance', 'vendor_balance'] as const;

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_date'), componentId: Uuid, key: z.enum(DATE_KEYS), on: IsoDate.nullable(), done: z.boolean().nullish() }),
  z.object({ op: z.literal('receive'), componentId: Uuid, condition: z.enum(['GOOD', 'DAMAGED', 'PARTIAL', 'WRONG_ITEM']), qty: Qty.nullish(), storageLocationId: Uuid.nullish(), photoIds: z.array(Uuid).max(20).default([]), notes: Text(1000).nullish() }),
]);

/** Move a date (or mark it done) and receive / inspect a component (damage needs a photo; a freight claim opens). */
export const POST = route({ access: { cap: 'projects.selections', action: 'view' }, body: Op }, async ({ db, body }) => {
  if (body.op === 'set_date') return { id: await xcall<string>(db, 'dsn_set_component_date', { p_component: body.componentId, p_key: body.key, p_on: body.on, p_done: body.done ?? null }) };
  return xcall(db, 'dsn_receive_component', { p_component: body.componentId, p_condition: body.condition, p_qty: body.qty ?? null, p_storage_location: body.storageLocationId ?? null, p_photos: body.photoIds, p_notes: body.notes ?? null });
});
