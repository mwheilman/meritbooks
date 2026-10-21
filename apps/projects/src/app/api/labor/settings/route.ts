export const dynamic = 'force-dynamic';

import { assertCompany, route } from '@/lib/api';
import { laborCall } from '@/lib/pm/labor/rpc';
import { LaborSettingsBody } from '@/lib/pm/labor/schemas';

/**
 * Company labor defaults (pm.set_labor_settings, 1108): payroll burden (job cost) and the
 * overhead allocation (estimating only — never charged to the job).
 */
export const POST = route({ body: LaborSettingsBody }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  await laborCall(db, 'set_labor_settings', { p_location: body.companyId, p_burden_pct: body.burdenPct, p_overhead_pct: body.overheadPct, p_notes: body.notes ?? null });
  return { ok: true };
});
