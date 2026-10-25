export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { resRpc } from '@/lib/residential/rpc';
import { Day, Uuid } from '@/lib/residential/schemas';

export interface CalendarItem {
  id: string;
  job_id?: string | null;
  job_number?: string | null;
  pursuit_id?: string;
  source: 'KEY_DATE' | 'COVENANT' | 'ENTITLEMENT' | 'CONDITION' | 'PURSUIT';
  kind: string;
  label: string;
  due_on: string;
  status: string;
  in_window: boolean;
  overdue: boolean;
}

/** Key dates and the covenant calendar (RED-06): PSA, loan, covenants, hearings, conditions and pursuit dates in one list. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ company: Uuid.optional(), from: Day.optional(), to: Day.optional() }) },
  async ({ db, query, tenant }) => {
    if (query.company) assertCompany(tenant, query.company);
    return resRpc<{ from: string; to: string; items: CalendarItem[] }>(db, 'dev_calendar', { p_location: query.company ?? null, p_from: query.from ?? null, p_to: query.to ?? null });
  });

/** Send today's reminders now (the daily sweep does this on its own). */
export const POST = route({ access: { cap: 'projects.financials', action: 'view' }, mask: false, body: z.object({ companyId: Uuid }) }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  return { notified: await resRpc<number>(db, 'dev_send_date_reminders', { p_location: body.companyId }) };
});
