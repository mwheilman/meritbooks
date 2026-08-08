export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireResetAuthority } from '@/lib/tenant-reset/reset-guard';
import {
  RESET_TABLES,
  RESET_PRESERVED,
  tableKey,
  type ResetTable,
} from '@/lib/tenant-reset/reset-plan';

/**
 * GET /api/tenant-reset/plan
 *
 * The PREVIEW. Strongly gated (company_admin + platform staff). Read-only:
 * returns the per-table row count that a reset WOULD clear for THIS org, grouped
 * by scope, plus the preserved-shell list and whether the destructive admin RPC
 * is installed (drives the degrade-safe button state). Deletes NOTHING.
 */

interface TableCount extends ResetTable {
  key: string;
  count: number;
  /** true when the table could not be counted (missing/dropped) — treated as 0. */
  unavailable: boolean;
}

async function countTable(
  admin: SupabaseClient,
  orgId: string,
  t: ResetTable,
): Promise<TableCount> {
  try {
    const q = admin.schema(t.schema).from(t.table);
    const { count, error } = await q
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId);
    if (error) {
      return { ...t, key: tableKey(t), count: 0, unavailable: true };
    }
    return { ...t, key: tableKey(t), count: count ?? 0, unavailable: false };
  } catch {
    return { ...t, key: tableKey(t), count: 0, unavailable: true };
  }
}

/** Probe whether the reserved destructive RPC is installed, WITHOUT running it. */
async function isResetRpcInstalled(admin: SupabaseClient): Promise<boolean> {
  try {
    // Non-destructive companion function (see reported migration). PGRST202 =
    // "function not found" => not installed yet => degrade safe.
    const { error } = await admin.rpc('tenant_reset_available');
    if (!error) return true;
    const code = (error as { code?: string }).code;
    if (code === 'PGRST202') return false;
    // Any other error (unexpected) — be conservative and report not-installed.
    return false;
  } catch {
    return false;
  }
}

async function countInChunks(
  admin: SupabaseClient,
  orgId: string,
  tables: readonly ResetTable[],
  chunkSize = 12,
): Promise<TableCount[]> {
  const out: TableCount[] = [];
  for (let i = 0; i < tables.length; i += chunkSize) {
    const chunk = tables.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map((t) => countTable(admin, orgId, t)));
    out.push(...results);
  }
  return out;
}

export async function GET() {
  const gate = await requireResetAuthority();
  if (!gate.ok) return gate.response;
  const { admin, authority } = gate;

  const [counts, rpcInstalled] = await Promise.all([
    countInChunks(admin, authority.orgId, RESET_TABLES),
    isResetRpcInstalled(admin),
  ]);

  return NextResponse.json({
    org: { id: authority.orgId, name: authority.orgName },
    rpcInstalled,
    preserved: RESET_PRESERVED,
    tables: counts.map((c) => ({
      key: c.key,
      schema: c.schema,
      table: c.table,
      label: c.label,
      group: c.group,
      scope: c.scope,
      count: c.count,
      unavailable: c.unavailable,
    })),
  });
}
