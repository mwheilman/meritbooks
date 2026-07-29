export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data, error } = await supabase
    .from('cost_approval_rules')
    .select('*')
    .eq('org_id', orgId)
    .order('priority', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const matchType = String(body.match_type ?? '');
  const approverType = String(body.approver_type ?? '');
  if (!['VENDOR', 'GL_CODE', 'TRANSACTION_SOURCE', 'DEFAULT'].includes(matchType)) {
    return NextResponse.json({ error: 'Invalid match_type' }, { status: 422 });
  }
  if (!['ACCOUNTING', 'RESPONSIBLE_PARTY', 'PM_LEADER'].includes(approverType)) {
    return NextResponse.json({ error: 'Invalid approver_type' }, { status: 422 });
  }

  const { data, error } = await supabase.from('cost_approval_rules').insert({
    org_id: orgId,
    match_type: matchType,
    match_value: matchType === 'DEFAULT' ? null : (body.match_value as string) ?? null,
    approver_type: approverType,
    approver_ref: (body.approver_ref as string) ?? null,
    priority: Number.isFinite(Number(body.priority)) ? Math.round(Number(body.priority)) : 100,
    is_active: body.is_active === false ? false : true,
  }).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}

export async function DELETE(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const { error } = await supabase.from('cost_approval_rules').delete().eq('org_id', orgId).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
