export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireResetAuthority } from '@/lib/tenant-reset/reset-guard';
import {
  tablesForOptions,
  tableKey,
  type ResetOptions,
  type ResetTable,
} from '@/lib/tenant-reset/reset-plan';

/**
 * GET /api/tenant-reset/export?clearMasterData=&clearChartOfAccounts=
 *
 * Produces a downloadable JSON snapshot of EXACTLY the rows a reset (under the
 * given options) would clear, so the operator always has a portable copy before
 * anything is deleted. Strongly gated (company_admin + platform staff), read-only.
 *
 * Rows per table are capped (a safety valve against an unbounded response); a
 * truncated table is flagged so the operator knows the DB-side snapshot the RPC
 * takes is the authoritative archive.
 */

const MAX_ROWS_PER_TABLE = 20_000;

async function dumpTable(
  admin: SupabaseClient,
  orgId: string,
  t: ResetTable,
): Promise<{ rows: unknown[]; truncated: boolean; unavailable: boolean }> {
  try {
    const { data, error } = await admin
      .schema(t.schema).from(t.table)
      .select('*')
      .eq('org_id', orgId)
      .limit(MAX_ROWS_PER_TABLE + 1);
    if (error) return { rows: [], truncated: false, unavailable: true };
    const rows = data ?? [];
    const truncated = rows.length > MAX_ROWS_PER_TABLE;
    return { rows: truncated ? rows.slice(0, MAX_ROWS_PER_TABLE) : rows, truncated, unavailable: false };
  } catch {
    return { rows: [], truncated: false, unavailable: true };
  }
}

export async function GET(request: Request) {
  const gate = await requireResetAuthority();
  if (!gate.ok) return gate.response;
  const { admin, authority } = gate;

  const { searchParams } = new URL(request.url);
  const options: ResetOptions = {
    clearMasterData: searchParams.get('clearMasterData') === 'true',
    clearChartOfAccounts: searchParams.get('clearChartOfAccounts') === 'true',
  };

  const tables = tablesForOptions(options);
  const data: Record<string, unknown[]> = {};
  const meta: Array<{ key: string; rowCount: number; truncated: boolean; unavailable: boolean }> = [];

  // Serial dump keeps peak memory/connection use bounded on large tenants.
  for (const t of tables) {
    const { rows, truncated, unavailable } = await dumpTable(admin, authority.orgId, t);
    const key = tableKey(t);
    data[key] = rows;
    meta.push({ key, rowCount: rows.length, truncated, unavailable });
  }

  const snapshot = {
    exportedAt: new Date().toISOString(),
    org: { id: authority.orgId, name: authority.orgName },
    exportedBy: authority.clerkUserId,
    options,
    note:
      'Client-side snapshot taken before a tenant reset. Row caps may truncate very large tables; the DB-side snapshot the reset RPC takes is the authoritative archive.',
    tables: meta,
    data,
  };

  const safeName = (authority.orgName || 'tenant').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = `meritbooks-reset-export-${safeName}-${stamp}.json`;

  return new NextResponse(JSON.stringify(snapshot, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
