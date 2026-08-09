export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { effectiveMatrix } from '@/lib/rbac/resolve-permissions';

/**
 * GET /api/rbac/roles/[roleKey]
 *
 * Admin-only. Returns the EFFECTIVE permission matrix for a single role (system OR
 * custom): every (feature, action) cell with its merged decision, the shipped default,
 * and whether the cell is an org OVERRIDE or the plain default. This is what lets the UI
 * both EXPLAIN the defaults and SHOW which cells the org has customized.
 *
 * Fails closed: a non-admin gets 403; an unknown role yields a fully-denied matrix.
 */
export async function GET(_req: NextRequest, { params }: { params: { roleKey: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const roleKey = decodeURIComponent(params.roleKey ?? '').trim();
  if (!roleKey) {
    return NextResponse.json({ error: 'Missing role', code: 'BAD_REQUEST' }, { status: 400 });
  }

  // Resolver reads the org's custom role + overrides and merges with the frozen default.
  const matrix = await effectiveMatrix(supabase, orgId!, roleKey);
  return NextResponse.json({ data: matrix });
}
