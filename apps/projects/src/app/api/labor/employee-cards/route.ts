export const dynamic = 'force-dynamic';

import { assertCompany, route } from '@/lib/api';
import { laborCall } from '@/lib/pm/labor/rpc';
import { EmployeeCardBody } from '@/lib/pm/labor/schemas';

/** Put an employee on a rate card for this company (null takes them off it). */
export const POST = route({ body: EmployeeCardBody }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  await laborCall(db, 'set_employee_rate_card', { p_employee: body.employeeId, p_location: body.companyId, p_rate_card: body.rateCardId });
  return { ok: true };
});
