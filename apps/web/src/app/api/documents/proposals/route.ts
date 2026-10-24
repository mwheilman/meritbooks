export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { proposalsQuery } from '@/lib/validations/document-intelligence';
import { intelDeps } from '@/lib/documents/intelligence/server';
import { syncNative } from '@/lib/documents/intelligence/service';
import { errorResponse, guardCenter, guardTarget, noOrg } from '@/lib/documents/intelligence/route-auth';
import { presentProposal, presentProposalSummary } from '@/lib/documents/intelligence/present';
import type { ProposalDto, ProposalSummaryDto } from '@/lib/documents/intelligence/types';

/**
 * GET /api/documents/proposals — module proposals made from documents.
 *
 *   ?target_kind=lease[&status=pending][&location_id=]   the module banner ("1 lease found
 *                                                         in your documents — review")
 *   ?id=…                                                 one proposal (to pre-fill the
 *                                                         module's review form)
 *
 * Each proposal carries its document's file name / type / upload date. RLS-scoped reads
 * (org + client scope). Gate: the module's own gate when a kind is given, else the center's.
 * The LIST never carries `payload` (the extracted terms); `?id=` returns it, TIN-redacted.
 */
export const GET = apiQueryHandler(proposalsQuery, async (q, { userId, orgId, supabase }) => {
  if (!orgId) return noOrg();
  try {
    if (q.id) {
      const { data } = await supabase.from('document_proposals').select('*').eq('org_id', orgId).eq('id', q.id).maybeSingle();
      const p = data as ProposalDto | null;
      if (!p) return NextResponse.json({ error: 'Proposal not found', code: 'NOT_FOUND' }, { status: 404 });
      const guard = await guardTarget(userId, p.target_kind, '/api/documents/proposals');
      if (!guard.ok) return guard.response;
      const { data: doc } = await supabase.from('documents').select('id, file_name, mime_type, doc_type, created_at').eq('id', p.document_id).maybeSingle();
      return NextResponse.json({ data: presentProposal(p), document: doc ?? null });
    }

    const guard = q.target_kind ? await guardTarget(userId, q.target_kind, '/api/documents/proposals') : await guardCenter(userId, '/api/documents/proposals');
    if (!guard.ok) return guard.response;
    await syncNative(intelDeps(), orgId).catch(() => 0);

    let query = supabase
      .from('document_proposals')
      .select('id, document_id, location_id, target_kind, mode, status, extract_state, title, summary, confidence, native_table, native_id, target_href, accepted_target_type, accepted_target_id, last_error, created_at')
      .eq('org_id', orgId);
    if (q.target_kind) query = query.eq('target_kind', q.target_kind);
    const status = q.status ?? 'pending';
    if (status !== 'all') query = query.eq('status', status);
    if (q.location_id) query = query.or(`location_id.eq.${q.location_id},location_id.is.null`);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as ProposalSummaryDto[]).map(presentProposalSummary);

    const ids = Array.from(new Set(rows.map((r) => r.document_id)));
    const docs = new Map<string, { id: string; file_name: string; mime_type: string | null; created_at: string }>();
    if (ids.length) {
      const { data: d } = await supabase.from('documents').select('id, file_name, mime_type, created_at').in('id', ids);
      for (const x of (d ?? []) as Array<{ id: string; file_name: string; mime_type: string | null; created_at: string }>) docs.set(x.id, x);
    }
    return NextResponse.json({
      data: rows.map((r) => ({ ...r, document: docs.get(r.document_id) ?? null })),
      count: rows.length,
    });
  } catch (e) {
    return errorResponse(e, 'Failed to load proposals');
  }
});
