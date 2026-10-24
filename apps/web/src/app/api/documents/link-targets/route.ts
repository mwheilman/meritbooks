export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { linkTargetsQuery } from '@/lib/validations/document-intelligence';
import { isRecordType, searchRecords } from '@/lib/documents/intelligence/records';
import { errorResponse, guardRecord, noOrg } from '@/lib/documents/intelligence/route-auth';

/**
 * GET /api/documents/link-targets?type=lease&q=main[&location_id=] — records a document can
 * be linked to ("Link to existing record"). Searched through the member's RLS client, so
 * only records in the caller's org and client scope come back. The record's module gate.
 */
export const GET = apiQueryHandler(linkTargetsQuery, async (q, { userId, orgId, supabase }) => {
  if (!orgId) return noOrg();
  if (!isRecordType(q.type)) return NextResponse.json({ error: 'That record type cannot be linked.', code: 'BAD_TARGET' }, { status: 400 });
  const g = guardRecord(userId, q.type, '/api/documents/link-targets');
  if (!g) return NextResponse.json({ error: 'That record type cannot be linked.', code: 'BAD_TARGET' }, { status: 400 });
  const guard = await g;
  if (!guard.ok) return guard.response;
  try {
    const data = await searchRecords(supabase, orgId, q.type, q.q ?? '', q.location_id ?? null);
    return NextResponse.json({ data });
  } catch (e) {
    return errorResponse(e, 'Failed to search records');
  }
});
