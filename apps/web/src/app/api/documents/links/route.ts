export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { assertWriteScope } from '@/lib/db/scoped-writer';
import { linksQuery, unlinkBody } from '@/lib/validations/document-intelligence';
import { intelDeps } from '@/lib/documents/intelligence/server';
import { unlink } from '@/lib/documents/intelligence/service';
import { errorResponse, guardCenter, guardRecord, noOrg } from '@/lib/documents/intelligence/route-auth';
import type { LinkDto } from '@/lib/documents/intelligence/types';

/**
 * /api/documents/links — the two-way document ↔ record links.
 *
 * GET ?document_id=        → the records a document is linked to ("Linked to Lease: …")
 * GET ?target_type=&target_id= → the documents behind a record ("Source document")
 *     (each with file name / type), RLS-scoped. Center gate for by-document; the record's
 *     module gate for by-record.
 * POST { link_id }         → remove a link (center gate + the record's module gate).
 */
export const GET = apiQueryHandler(linksQuery, async (q, { userId, orgId, supabase }) => {
  if (!orgId) return noOrg();
  try {
    if (q.document_id) {
      const guard = await guardCenter(userId, '/api/documents/links');
      if (!guard.ok) return guard.response;
      const { data } = await supabase.from('document_links').select('*').eq('org_id', orgId).eq('document_id', q.document_id).order('created_at', { ascending: true });
      return NextResponse.json({ data: (data ?? []) as LinkDto[] });
    }
    const g = guardRecord(userId, q.target_type as string, '/api/documents/links');
    const guard = g ? await g : await guardCenter(userId, '/api/documents/links');
    if (!guard.ok) return guard.response;
    const { data } = await supabase
      .from('document_links')
      .select('*')
      .eq('org_id', orgId)
      .eq('target_type', q.target_type as string)
      .eq('target_id', q.target_id as string)
      .order('created_at', { ascending: true });
    const links = (data ?? []) as LinkDto[];
    const ids = links.map((l) => l.document_id);
    const docs = new Map<string, { id: string; file_name: string; mime_type: string | null; doc_type: string; created_at: string }>();
    if (ids.length) {
      const { data: d } = await supabase.from('documents').select('id, file_name, mime_type, doc_type, created_at').in('id', ids);
      for (const x of (d ?? []) as Array<{ id: string; file_name: string; mime_type: string | null; doc_type: string; created_at: string }>) docs.set(x.id, x);
    }
    return NextResponse.json({ data: links.map((l) => ({ ...l, document: docs.get(l.document_id) ?? null })) });
  } catch (e) {
    return errorResponse(e, 'Failed to load links');
  }
});

export const POST = apiHandler(unlinkBody, async (body, { userId, orgId, supabase }) => {
  if (!orgId) return noOrg();
  const guard = await guardCenter(userId, '/api/documents/links');
  if (!guard.ok) return guard.response;
  try {
    const { data } = await supabase.from('document_links').select('id, target_type, location_id').eq('org_id', orgId).eq('id', body.link_id).maybeSingle();
    const link = data as { id: string; target_type: string; location_id: string | null } | null;
    if (!link) return NextResponse.json({ error: 'Link not found', code: 'NOT_FOUND' }, { status: 404 });
    const g = guardRecord(userId, link.target_type, '/api/documents/links');
    if (g) {
      const rg = await g;
      if (!rg.ok) return rg.response;
    }
    await assertWriteScope(supabase, orgId, [link.location_id]);
    await unlink(intelDeps(), { orgId, linkId: link.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e, 'Failed to remove the link');
  }
});
