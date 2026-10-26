export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { analyzeBody, type AnalyzeBody } from '@/lib/validations/document-intelligence';
import { intelDeps } from '@/lib/documents/intelligence/server';
import { analyzeDocument, backfillMessage, backfillOrg } from '@/lib/documents/intelligence/service';
import { draftAuthorizer, errorResponse, guardCenter, maskForeignDuplicates, noOrg } from '@/lib/documents/intelligence/route-auth';
import { presentIntel, presentProposalSummary } from '@/lib/documents/intelligence/present';
import { loadClientScope } from '@/lib/rbac/client-scope';
import { aiUnavailablePayload } from '@/lib/ai/gateway';

/**
 * POST /api/documents/intelligence/analyze — read documents and route them to modules.
 *
 *   { document_id }        one document (right after an upload, or "Re-read")
 *   { all: true, limit? }  "Analyze existing documents" — the backfill, 25 per call.
 *                          Only for a caller who sees every company (all-clients scope, or
 *                          client scope off): a backfill reads documents org-wide.
 *
 * The document must be visible to the caller through RLS (wrong tenant → 404). Proposals
 * only; never a 5xx for "AI off" — the deterministic rules answer and a retry is queued.
 * audit_trail:view (the Documents center gate) to read; a module DRAFT (staged extract,
 * AP intake draft, vendor submission) is only made when the caller also holds that
 * module's gate and the document's company is in their scope (draftAuthorizer).
 */
export const POST = apiHandler(analyzeBody, async (body: AnalyzeBody, { userId, orgId, supabase }) => {
  const route = '/api/documents/intelligence/analyze';
  const guard = await guardCenter(userId, route);
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const deps = intelDeps();
  const canDraft = draftAuthorizer({ userId, orgId, supabase, route });
  try {
    if ('document_id' in body) {
      const { data: visible } = await supabase.from('documents').select('id').eq('id', body.document_id).maybeSingle();
      if (!visible) return NextResponse.json({ error: 'Document not found', code: 'NOT_FOUND' }, { status: 404 });
      const r = await analyzeDocument(deps, { orgId, documentId: body.document_id, userId, source: 'center', force: body.force, canDraft });
      const [intelligence] = r.intelligence ? await maskForeignDuplicates(supabase, [presentIntel(r.intelligence)]) : [null];
      return NextResponse.json({
        intelligence,
        proposals: r.proposals.map(presentProposalSummary),
        message: r.message,
        skipped: r.skipped ?? null,
        ...(deps.anthropicApiKey ? {} : { ai: aiUnavailablePayload('AI is paused — this document was typed by rules and will be re-read when AI is back.') }),
      });
    }

    const scope = await loadClientScope({ supabase });
    if (scope.mode !== 'off' && !scope.allClients) {
      return NextResponse.json(
        { error: 'Analyzing every document needs access to all companies. Open a document to analyze it on its own.', code: 'ALL_CLIENTS_REQUIRED' },
        { status: 403 },
      );
    }
    const r = await backfillOrg(deps, { orgId, userId, limit: body.limit ?? 25, canDraft });
    const message = backfillMessage(r);
    // Per-document error text can carry service detail: counts only to the browser.
    return NextResponse.json({ result: { ...r, errors: r.errors.length }, message });
  } catch (e) {
    return errorResponse(e, 'Failed to analyze documents');
  }
});
