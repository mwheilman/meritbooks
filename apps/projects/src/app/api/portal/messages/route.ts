export const dynamic = 'force-dynamic';

import { portalHandler, portalJson } from '@/lib/portal/http';
import { portalRpc } from '@/lib/portal/db';
import { isUuid } from '@/lib/portal/tokens';
import type { PortalMessage } from '@/lib/portal/types';

/** PUBLIC (session cookie): one job thread for one audience (?orgId&jobId&audience). */
export const GET = portalHandler({}, async ({ req, session }) => {
  const p = req.nextUrl.searchParams;
  const org = p.get('orgId'); const job = p.get('jobId'); const audience = p.get('audience');
  if (!isUuid(org) || !isUuid(job) || !['customer', 'vendor', 'lender', 'investor'].includes(audience ?? '')) {
    return portalJson(422, { error: 'Check the conversation.', code: 'invalid' });
  }
  const messages = await portalRpc<PortalMessage[]>('messages', { p_session: session, p_org: org, p_job: job, p_audience: audience });
  return { messages };
});
