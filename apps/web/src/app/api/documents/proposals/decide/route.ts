export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { assertWriteScope } from '@/lib/db/scoped-writer';
import { decideProposalBody, type DecideProposalBody } from '@/lib/validations/document-intelligence';
import { intelDeps } from '@/lib/documents/intelligence/server';
import { acceptProposal, dismissProposal, loadProposal } from '@/lib/documents/intelligence/service';
import { resolveRecord } from '@/lib/documents/intelligence/records';
import { errorResponse, guardRecord, guardTarget, noOrg } from '@/lib/documents/intelligence/route-auth';
import { presentProposalSummary } from '@/lib/documents/intelligence/present';
import { ACCEPT_RECORD_TYPES, acceptableRecordType } from '@/lib/documents/intelligence/types';

/**
 * POST /api/documents/proposals/decide
 *
 *   accept  { proposal_id, target_type, target_id }  — called by the MODULE right after its
 *           own create path made the record from the proposal (or when a person points the
 *           proposal at an existing record). Verifies the record exists in the org, links
 *           document ↔ record both ways, closes the proposal. For a vendor W-9 / COI with no
 *           vendor yet, target_type 'vendor' lodges the submission in Vendor compliance.
 *   dismiss { proposal_id, note? }
 *
 * Gate: the target module's own gate (lease → journal_entries:create, bill → bills:create,
 * …). Accept: the record type must be one this proposal kind may close onto (a lease
 * proposal → a lease; ACCEPT_RECORD_TYPES) and the caller must hold that RECORD's module
 * gate too (guardRecord). The proposal must be RLS-visible; its company and the record's
 * must be in the caller's client scope.
 */
export const POST = apiHandler(decideProposalBody, async (body: DecideProposalBody, { userId, orgId, supabase }) => {
  if (!orgId) return noOrg();
  const deps = intelDeps();
  try {
    const { data: visible } = await supabase.from('document_proposals').select('id').eq('id', body.proposal_id).maybeSingle();
    if (!visible) return NextResponse.json({ error: 'Proposal not found', code: 'NOT_FOUND' }, { status: 404 });
    const p = await loadProposal(deps.db, orgId, body.proposal_id);
    if (!p) return NextResponse.json({ error: 'Proposal not found', code: 'NOT_FOUND' }, { status: 404 });
    const guard = await guardTarget(userId, p.target_kind, '/api/documents/proposals/decide');
    if (!guard.ok) return guard.response;
    await assertWriteScope(supabase, orgId, [p.location_id]);

    if (body.action === 'dismiss') {
      const proposal = await dismissProposal(deps, { orgId, proposalId: p.id, userId, note: body.note ?? null });
      return NextResponse.json({ proposal: presentProposalSummary(proposal), message: 'Dismissed.' });
    }
    if (!acceptableRecordType(p.target_kind, body.target_type)) {
      return NextResponse.json(
        { error: `This proposal can only be linked to: ${ACCEPT_RECORD_TYPES[p.target_kind].join(', ')}.`, code: 'BAD_TARGET' },
        { status: 400 },
      );
    }
    const rg = guardRecord(userId, body.target_type, '/api/documents/proposals/decide');
    if (!rg) return NextResponse.json({ error: 'That record type cannot be linked.', code: 'BAD_TARGET' }, { status: 400 });
    const recordGuard = await rg;
    if (!recordGuard.ok) return recordGuard.response;
    const rec = await resolveRecord(deps.db, orgId, body.target_type, body.target_id);
    if (!rec) return NextResponse.json({ error: 'That record was not found.', code: 'TARGET_NOT_FOUND' }, { status: 404 });
    await assertWriteScope(supabase, orgId, [rec.locationId]);
    const r = await acceptProposal(deps, { orgId, proposalId: p.id, userId, targetType: body.target_type, targetId: body.target_id, note: body.note ?? null });
    return NextResponse.json({ proposal: presentProposalSummary(r.proposal), message: `Linked to ${r.label}.` });
  } catch (e) {
    return errorResponse(e, 'Failed to record the decision');
  }
});
