export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import type { PayrollFieldTarget } from '@/lib/payroll/register-csv';

/**
 * /api/payroll/register-mappings — saved per-provider column mappings for the
 * DETERMINISTIC payroll-register importer.
 *
 *   GET    → list this tenant's saved mappings (RLS org-scoped).
 *   POST   → upsert a mapping by provider name ({ providerName, mapping, headerSignature }).
 *   DELETE ?id=<uuid> → remove a saved mapping.
 *
 * These are UI-convenience templates only — nothing here posts to the ledger. RLS on
 * public.payroll_register_mappings (migration 136) isolates them per org.
 *
 * Access: gated on `payroll:create` (same tier as the import path).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TARGETS: ReadonlySet<string> = new Set<PayrollFieldTarget>([
  'ignore', 'employee', 'gross', 'fed_wh', 'state_wh', 'local_wh', 'fica_ss',
  'fica_medicare', 'fica', 'net', 'employer_tax', 'deduction',
]);

interface MappingRow {
  id: string;
  provider_name: string;
  mapping: unknown;
  header_signature: string | null;
  updated_at: string;
}

export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'create');
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from('payroll_register_mappings')
    .select('id, provider_name, mapping, header_signature, updated_at')
    .eq('org_id', orgId)
    .order('provider_name', { ascending: true });
  if (error) return NextResponse.json({ error: error.message, code: 'DB' }, { status: 500 });

  const mappings = ((data ?? []) as MappingRow[]).map((r) => ({
    id: r.id,
    providerName: r.provider_name,
    mapping: r.mapping,
    headerSignature: r.header_signature,
    updatedAt: r.updated_at,
  }));
  return NextResponse.json({ mappings });
}

interface SaveBody {
  providerName?: unknown;
  mapping?: unknown;
  headerSignature?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'create');
  if (!guard.ok) return guard.response;

  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
  }

  const providerName = typeof body.providerName === 'string' ? body.providerName.trim() : '';
  if (!providerName) {
    return NextResponse.json({ error: 'A provider name is required to save a mapping', code: 'VALIDATION' }, { status: 422 });
  }
  if (providerName.length > 80) {
    return NextResponse.json({ error: 'Provider name is too long (max 80 characters)', code: 'VALIDATION' }, { status: 422 });
  }
  if (!Array.isArray(body.mapping) || body.mapping.length === 0) {
    return NextResponse.json({ error: 'mapping must be a non-empty array', code: 'VALIDATION' }, { status: 422 });
  }

  // Persist only the minimal, stable mapping (header → target [+ label]).
  const mapping = body.mapping.map((raw) => {
    const m = (raw ?? {}) as { header?: unknown; target?: unknown; label?: unknown };
    const target = typeof m.target === 'string' && VALID_TARGETS.has(m.target) ? m.target : 'ignore';
    const out: { header: string; target: string; label?: string } = {
      header: typeof m.header === 'string' ? m.header : '',
      target,
    };
    if (typeof m.label === 'string' && m.label.trim() !== '') out.label = m.label.trim();
    return out;
  });
  const headerSignature = typeof body.headerSignature === 'string' ? body.headerSignature.slice(0, 2000) : null;

  const { data, error } = await supabase
    .from('payroll_register_mappings')
    .upsert(
      {
        org_id: orgId,
        provider_name: providerName,
        mapping,
        header_signature: headerSignature,
        created_by_user: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,provider_name' },
    )
    .select('id, provider_name')
    .single();
  if (error) return NextResponse.json({ error: error.message, code: 'DB' }, { status: 500 });

  return NextResponse.json({ ok: true, id: (data as { id: string }).id, providerName });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'create');
  if (!guard.ok) return guard.response;

  const id = new URL(request.url).searchParams.get('id');
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'A valid mapping id is required', code: 'VALIDATION' }, { status: 422 });
  }
  const { error } = await supabase
    .from('payroll_register_mappings')
    .delete()
    .eq('org_id', orgId)
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message, code: 'DB' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
