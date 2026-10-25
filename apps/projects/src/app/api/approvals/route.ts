export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { afterApproval, approvalSummary, decideObject, loadInbox } from '@/lib/approvals/server';
import { isObjectType, type ApprovalObjectType } from '@/lib/approvals/types';
import { DecideBody, InboxQuery } from './schemas';

/**
 * GET /api/approvals — the caller's queue (also the phone app's): `?mine` or `?tab=mine|waiting|
 * decided|all`, `type=change_order,commitment`, `companyId`, `jobId`, `overdue=1`. Rows the caller
 * may not see never come back; amounts are null where the money is not theirs to see.
 */
export const GET = route({ access: 'none', mask: false, query: InboxQuery }, async ({ db, query, tenant }) => {
  const types = (query.type ?? '').split(',').map((s) => s.trim()).filter(isObjectType) as ApprovalObjectType[];
  return loadInbox(db, {
    tab: query.mine !== undefined ? 'mine' : query.tab ?? 'mine',
    types,
    companyId: query.companyId ?? tenant.activeCompanyId ?? null,
    jobId: query.jobId ?? null,
    overdue: query.overdue === '1' || query.overdue === 'true',
    limit: query.limit,
  });
});

/**
 * POST /api/approvals — approve / reject / submit an object by type and id (object pages and the
 * phone). Opens its approval request when needed; the engine decides who may act.
 */
export const POST = route({ access: 'none', mask: false, body: DecideBody }, async ({ db, body, tenant }) => {
  const r = await decideObject(db, body.objectType, body.objectId, {
    decision: body.decision, reason: body.reason ?? null, selfReason: body.selfReason ?? null, ref: body.ref ?? null, channel: body.channel,
  });
  return { ...r, approval: approvalSummary(r), ...(await afterApproval(db, r, tenant.booksPresent)) };
});
