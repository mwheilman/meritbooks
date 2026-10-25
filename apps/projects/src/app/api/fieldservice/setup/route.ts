import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import { rpcLoad } from '@/lib/fieldservice/completion';
import type { SetupStatus, ShadowReport } from '@/lib/fieldservice/completion-types';
import { Cents, Day, Text, Uuid } from '@/lib/pm/ops/schemas';

/**
 * Guided setup and the shadow run (FS-117). GET: what is set up (with links) and the shadow-run
 * days so far. POST: load the starter setup (1117 + 1123 seeds — job types, windows, capacity,
 * price book, checklists, cadences, templates, permit template, install capacity) and record one
 * shadow-run day: the old system's totals against what Merit recorded that day.
 */
export const GET = route({ access: { cap: 'projects.settings', action: 'view' }, mask: false, query: z.object({ companyId: Uuid, from: Day.optional(), to: Day.optional() }) }, async ({ db, tenant, query }) => {
  assertCompany(tenant, query.companyId);
  const [status, shadow] = await Promise.all([
    rpcLoad<SetupStatus>(db, 'fs_setup_status', { p_location: query.companyId }, { steps: [], done: 0, total: 0 }),
    rpcLoad<ShadowReport>(db, 'fs_shadow_report', { p_location: query.companyId, p_from: query.from ?? null, p_to: query.to ?? null }, { days: [], matched_days: 0 }),
  ]);
  return { status: status.data, shadow: shadow.data, error: status.error ?? shadow.error };
});

const Legacy = z.object({ jobs: z.number().int().min(0).max(100_000), revenue_cents: Cents, payments_cents: Cents, memberships: z.number().int().min(0).max(100_000),
                          estimates_sold: z.number().int().min(0).max(100_000) });
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('seed'), companyId: Uuid, trades: z.array(z.enum(['HVAC', 'PLUMBING', 'ELECTRICAL'])).min(1).max(3).default(['HVAC', 'PLUMBING', 'ELECTRICAL']) }),
  z.object({ op: z.literal('shadow'), companyId: Uuid, day: Day, legacy: Legacy, system: z.enum(['SERVICETITAN', 'FIELDEDGE', 'SIMPRO', 'HOUSECALL_PRO', 'JOBBER', 'OTHER']), notes: Text(2000).nullish() }),
]);

export const POST = route({ access: { cap: 'projects.settings', action: 'view' }, mask: false, body: Body,
  ops: { seed: { cap: 'projects.settings', action: 'configure' } } }, async ({ db, body }) => {
  if (body.op === 'seed') {
    const base = await fsCall(db, 'fs_seed_field_service', { p_location: body.companyId, p_trades: body.trades });
    const more = await fsCall(db, 'fs_seed_completion', { p_location: body.companyId });
    return { base, completion: more };
  }
  return fsCall(db, 'fs_record_shadow_day', { p_location: body.companyId, p_day: body.day, p_legacy: body.legacy, p_system: body.system, p_notes: body.notes ?? null });
});
