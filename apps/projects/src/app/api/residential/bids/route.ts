export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resWrote } from '@/lib/residential/rpc';
import { Cents, Required, Text, Uuid } from '@/lib/residential/schemas';

const NewPackage = z.object({
  jobId: Uuid, title: Required(200, 'Name the package'), scope: Text(20000).nullish(), costCodeId: Uuid.nullish(), dueAt: z.string().datetime({ offset: true }).nullish(),
  lines: z.array(z.object({ description: Required(500, 'Describe the line'), qty: z.number().positive().max(1e9).default(1), uom: Text(12).default('LS'), costCodeId: Uuid.nullish(), budgetCents: Cents.nullish() })).min(1).max(200),
});

/** A bid package: scope + lines the trades price one by one (RES-30). */
export const POST = route({ access: { cap: 'projects.commitments', action: 'create' }, mask: false, body: NewPackage }, async ({ db, body, tenant }) => {
  const p = resWrote<Array<{ id: string }>>(await pm(db).from('res_bid_packages').insert({ org_id: tenant.orgId, job_id: body.jobId, title: body.title, scope: body.scope ?? null,
    cost_code_id: body.costCodeId ?? null, due_at: body.dueAt ?? null }).select('id'));
  const id = p[0]!.id;
  resWrote(await pm(db).from('res_bid_package_lines').insert(body.lines.map((l, i) => ({ org_id: tenant.orgId, package_id: id, description: l.description, qty: l.qty, uom: l.uom,
    cost_code_id: l.costCodeId ?? null, budget_cents: l.budgetCents ?? null, sort: i + 1 }))).select('id'));
  return { packageId: id };
});
