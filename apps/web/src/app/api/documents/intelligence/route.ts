export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { intelligenceListQuery } from '@/lib/validations/document-intelligence';
import { intelDeps } from '@/lib/documents/intelligence/server';
import { syncNative } from '@/lib/documents/intelligence/service';
import { errorResponse, guardCenter, maskForeignDuplicates, noOrg } from '@/lib/documents/intelligence/route-auth';
import { presentIntel, presentProposalSummary } from '@/lib/documents/intelligence/present';
import type { IntelligenceDto, LinkDto, ProposalSummaryDto } from '@/lib/documents/intelligence/types';

/**
 * GET /api/documents/intelligence — what each document is and where it went
 * (FPB-document-intelligence §8).
 *
 *   ?document_ids=a,b,…   the rows for the center's current page (≤ 100), with each
 *                         document's proposals and links
 *   ?status=needs_review  the rows in one state (≤ 200)
 *   always                org summary: needs review · proposals pending · AI deferred
 *
 * Reads go through the member's RLS client (org + client scope enforced by the DB). Before
 * reading, native queues are synced (an AP draft approved into a bill → linked). audit_trail:view.
 * Out: DTO columns only, TIN-shaped strings redacted, proposals WITHOUT their payload (the
 * terms come from GET /api/documents/proposals?id=), and `duplicate_of` only when the twin
 * is visible to the caller.
 */
export const GET = apiQueryHandler(intelligenceListQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await guardCenter(userId, '/api/documents/intelligence');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  try {
    await syncNative(intelDeps(), orgId).catch(() => 0);

    const ids = (q.document_ids ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 100);
    let rows: IntelligenceDto[] = [];
    if (ids.length > 0) {
      const { data } = await supabase.from('document_intelligence').select('*').eq('org_id', orgId).in('document_id', ids);
      rows = (data ?? []) as IntelligenceDto[];
    } else if (q.status || q.doc_class) {
      let sq = supabase.from('document_intelligence').select('*').eq('org_id', orgId);
      if (q.status) sq = sq.eq('status', q.status);
      if (q.doc_class) sq = sq.eq('doc_class', q.doc_class);
      const { data } = await sq.order('created_at', { ascending: false }).limit(200);
      rows = (data ?? []) as IntelligenceDto[];
    }
    const docIds = rows.map((r) => r.document_id);
    const lookup = ids.length ? ids : docIds;
    let proposals: ProposalSummaryDto[] = [];
    let links: LinkDto[] = [];
    if (lookup.length > 0) {
      const [p, l] = await Promise.all([
        supabase.from('document_proposals').select('*').eq('org_id', orgId).in('document_id', lookup).neq('status', 'superseded').order('created_at', { ascending: true }),
        supabase.from('document_links').select('*').eq('org_id', orgId).in('document_id', lookup).order('created_at', { ascending: true }),
      ]);
      proposals = ((p.data ?? []) as ProposalSummaryDto[]).map(presentProposalSummary);
      links = (l.data ?? []) as LinkDto[];
    }

    const [needs, pend, deferred, unread, total, allDocs, unfiled] = await Promise.all([
      supabase.from('document_intelligence').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'needs_review'),
      supabase.from('document_proposals').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'pending').neq('mode', 'route'),
      supabase.from('document_intelligence').select('id', { count: 'exact', head: true }).eq('org_id', orgId).not('next_retry_at', 'is', null),
      supabase.from('documents').select('id', { count: 'exact', head: true }).eq('org_id', orgId).or('entity_type.is.null,entity_type.eq.location'),
      supabase.from('document_intelligence').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
      // The band tiles: every stored file, and the ones not linked to a record (the same
      // `entity_type IS NULL` rule as GET /api/documents?linked=unfiled).
      supabase.from('documents').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
      supabase.from('documents').select('id', { count: 'exact', head: true }).eq('org_id', orgId).is('entity_type', null),
    ]);

    const data = await maskForeignDuplicates(supabase, rows.map(presentIntel));
    return NextResponse.json({
      data,
      proposals,
      links,
      summary: {
        needs_review: needs.count ?? 0,
        proposals_pending: pend.count ?? 0,
        ai_deferred: deferred.count ?? 0,
        not_analyzed: Math.max(0, (unread.count ?? 0) - (total.count ?? 0)),
        documents: allDocs.count ?? 0,
        unfiled: unfiled.count ?? 0,
      },
    });
  } catch (e) {
    return errorResponse(e, 'Failed to load document analysis');
  }
});
