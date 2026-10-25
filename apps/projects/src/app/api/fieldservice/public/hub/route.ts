export const dynamic = 'force-dynamic';

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { portalHandler } from '@/lib/portal/http';
import { PortalError } from '@/lib/portal/errors';
import { fsPortalRpc } from '@/lib/fieldservice/public-db';

/**
 * PUBLIC (portal session cookie) — the field-service client hub (FS-115) and online estimate
 * approval (FS-59). The database scopes everything to the person's grants (1118) and returns sell
 * prices and their own records only — never cost.
 *   GET  ?orgId=            visits (live tech status), estimates waiting, agreements, equipment, history
 *   GET  ?orgId=&estimate=  one estimate's options with member price, monthly payment, add-ons
 *   POST {op: accept}       pick an option, tick add-ons, sign (typed name + consent)
 *   POST {op: visit}        confirm a visit or ask for a new time
 */
const Id = z.string().uuid();

export async function GET(req: NextRequest) {
  return portalHandler({}, async ({ session }) => {
    const org = Id.safeParse(req.nextUrl.searchParams.get('orgId'));
    if (!org.success) throw new PortalError(422, 'invalid', 'Pick the company.');
    const est = req.nextUrl.searchParams.get('estimate');
    if (est) {
      const e = Id.safeParse(est);
      if (!e.success) throw new PortalError(422, 'invalid', 'That estimate link is not valid.');
      return fsPortalRpc('fs_estimate', { p_session: session, p_org: org.data, p_estimate: e.data });
    }
    return fsPortalRpc('fs_hub', { p_session: session, p_org: org.data });
  })(req);
}

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('accept'), orgId: Id, estimateId: Id, optionId: Id, addOns: z.array(Id).max(40).default([]),
             typedName: z.string().trim().min(2).max(200), consent: z.literal(true) }),
  z.object({ op: z.literal('visit'), orgId: Id, workOrderId: Id, response: z.enum(['CONFIRM', 'RESCHEDULE']), note: z.string().trim().max(500).nullish() }),
]);

export const POST = portalHandler({ body: Body }, async ({ body: b, session, meta }) => {
  if (b.op === 'accept') {
    return fsPortalRpc('fs_estimate_accept', { p_session: session, p_org: b.orgId, p_estimate: b.estimateId, p_option: b.optionId,
      p_optional_on: b.addOns, p_typed_name: b.typedName, p_consent: b.consent, p_ip: meta.ip, p_user_agent: meta.userAgent });
  }
  return fsPortalRpc('fs_confirm_visit', { p_session: session, p_org: b.orgId, p_wo: b.workOrderId, p_response: b.response, p_note: b.note ?? null,
    p_ip: meta.ip, p_user_agent: meta.userAgent });
});
