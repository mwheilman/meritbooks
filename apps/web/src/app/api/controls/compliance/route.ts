export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadComplianceCenter } from '@/lib/controls/compliance-center';

/**
 * GET /api/controls/compliance
 *
 * READ-ONLY aggregate of the trust & controls surface — the Controls / SOX
 * Compliance Command Center payload. Reads the exception library, money-movement
 * approvals (SoD), the autonomy posture, and the audit trail, and returns a control
 * catalog with per-control status + the driving numbers + evidence. It NEVER writes,
 * scans, or moves money.
 *
 * Auth: `apiQueryHandler` establishes identity + an RLS-scoped Supabase client, so
 * the database enforces tenant isolation. Gated on the existing `compliance:view`
 * permission (the same authority that governs the Compliance area) — held by
 * controller/CFO/company-admin; denied to narrow/entry roles (403).
 */
const querySchema = z.object({}).passthrough();

export const GET = apiQueryHandler(querySchema, async (_params, ctx): Promise<NextResponse> => {
  const { userId, orgId, supabase } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const guard = await requirePermission(userId, 'compliance', 'view');
  if (!guard.ok) return guard.response;

  const data = await loadComplianceCenter(supabase, orgId);
  return NextResponse.json({ data });
});
