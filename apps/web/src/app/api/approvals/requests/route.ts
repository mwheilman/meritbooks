export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import {
  submitToWorkflow,
  listRequests,
  getOpenRequestForDoc,
} from '@/lib/approvals/service';
import { WORKFLOW_DOC_TYPES } from '@/lib/approvals/workflow';

/**
 * GET  /api/approvals/requests   — list requests; or ?doc_type&doc_id for one doc's
 *                                  open chain (the approval-chain widget on a document).
 * POST /api/approvals/requests   — route a document INTO its workflow on submit. Returns
 *                                  { entered:false } when no active workflow / no band
 *                                  applies, so the caller keeps the existing
 *                                  single-approver behavior (posting is never forked).
 *
 * Any authenticated org member may submit their own document for approval and read the
 * chain state; the ACT endpoint is where role-at-step authority is enforced. Uses the
 * RLS-scoped client (ctx.supabase): the migration-092 tables are org-isolated by
 * `org_id = get_org_id()`, so the database enforces tenancy even if a filter is dropped.
 */

const querySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  doc_type: z.enum(WORKFLOW_DOC_TYPES as unknown as [string, ...string[]]).optional(),
  doc_id: z.string().uuid().optional(),
});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  if (params.doc_type && params.doc_id) {
    const request = await getOpenRequestForDoc(
      ctx.supabase,
      ctx.orgId,
      params.doc_type as (typeof WORKFLOW_DOC_TYPES)[number],
      params.doc_id
    );
    return NextResponse.json({ request });
  }

  const requests = await listRequests(ctx.supabase, ctx.orgId, {
    status: params.status,
    docType: params.doc_type as (typeof WORKFLOW_DOC_TYPES)[number] | undefined,
  });
  return NextResponse.json({ requests });
});

const submitSchema = z.object({
  docType: z.enum(WORKFLOW_DOC_TYPES as unknown as [string, ...string[]]),
  docId: z.string().uuid(),
  amountCents: z.number().int().min(0),
  linkApprovalId: z.string().uuid().nullable().optional(),
});

export const POST = apiHandler(submitSchema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const result = await submitToWorkflow(ctx.supabase, ctx.orgId, {
    docType: body.docType as (typeof WORKFLOW_DOC_TYPES)[number],
    docId: body.docId,
    amountCents: body.amountCents,
    preparedBy: ctx.userId,
    linkApprovalId: body.linkApprovalId ?? null,
  });
  return NextResponse.json(result, { status: result.entered ? 201 : 200 });
});
