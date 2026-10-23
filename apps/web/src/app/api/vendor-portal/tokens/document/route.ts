export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { DocAccessError, revealTinDocument } from '@/lib/vendor-compliance/doc-access';

/**
 * POST /api/vendor-portal/tokens/document { document_id, reason } — open a vendor's portal
 * W-9 image (security review M8). The image shows the full taxpayer ID, so this is a TIN
 * reveal: compliance:view AND a `tin` field level that allows a reveal (reveal_logged /
 * visible), the reveal logged to core.field_reveals + the action log BEFORE a 5-minute URL
 * is signed. The document row is read through the caller's RLS client (wrong tenant → 404).
 */
const body = z.object({ document_id: z.string().uuid(), reason: z.string().trim().min(3).max(500) });

export const POST = apiHandler(body, async (b, { userId, orgId, supabase }) => {
  const guard = await requirePermission(userId, 'compliance', 'view', { route: '/api/vendor-portal/tokens/document' });
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const { data: doc } = await supabase
    .from('documents')
    .select('id, mime_type, entity_type, notes')
    .eq('org_id', orgId)
    .eq('id', b.document_id)
    .maybeSingle();
  const d = doc as { id: string; mime_type: string | null; entity_type: string | null; notes: string | null } | null;
  if (!d || d.entity_type !== 'vendor' || !(d.notes ?? '').startsWith('Vendor portal submission')) {
    return NextResponse.json({ error: 'File not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  try {
    const link = await revealTinDocument(createAdminSupabase(), supabase, {
      orgId, userId, documentId: d.id, mimeType: d.mime_type, subjectTable: 'documents', subjectId: d.id, reason: b.reason,
    });
    return NextResponse.json(link);
  } catch (e) {
    if (e instanceof DocAccessError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
});
