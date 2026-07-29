export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';

// ─── GET: recent AI decisions (the explainability log) ────────────────────────
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');           // PROPOSED | APPROVED | REJECTED | EXPIRED
  const feature = searchParams.get('feature');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 200);

  if (!orgId) return NextResponse.json({ decisions: [] });

  let q = supabase
    .from('ai_decisions')
    .select('id, location_id, feature, model_used, correlation_id, input_summary, proposed_output, confidence, reasoning, clarifying_question, status, disposition_by_user, disposition_at, disposition_note, posted_gl_entry_id, tokens_input, tokens_output, cost_cents, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  if (feature) q = q.eq('feature', feature);

  const { data: decisions, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = decisions ?? [];

  // Stitch entity names (core) + posted entry numbers (public) — no cross-schema embed.
  const locIds = [...new Set(rows.map((r: Record<string, unknown>) => r.location_id).filter(Boolean))] as string[];
  const entryIds = [...new Set(rows.map((r: Record<string, unknown>) => r.posted_gl_entry_id).filter(Boolean))] as string[];

  const locName = new Map<string, string>();
  if (locIds.length) {
    const { data: locs } = await supabase.schema('core').from('locations').select('id, name').in('id', locIds);
    for (const l of locs ?? []) locName.set(l.id as string, l.name as string);
  }
  const entryNum = new Map<string, string>();
  if (entryIds.length) {
    const { data: ents } = await supabase.from('gl_entries').select('id, entry_number').in('id', entryIds);
    for (const e of ents ?? []) entryNum.set(e.id as string, e.entry_number as string);
  }

  return NextResponse.json({
    decisions: rows.map((r: Record<string, unknown>) => ({
      ...r,
      location_name: r.location_id ? locName.get(r.location_id as string) ?? null : null,
      entry_number: r.posted_gl_entry_id ? entryNum.get(r.posted_gl_entry_id as string) ?? null : null,
    })),
  });
}

// ─── PATCH: disposition a proposal (reject) ───────────────────────────────────
const patchSchema = z.object({
  decision_id: z.string().uuid(),
  status: z.literal('REJECTED'),
  note: z.string().max(1000).optional(),
});

export async function PATCH(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const { error } = await supabase
    .from('ai_decisions')
    .update({
      status: 'REJECTED',
      disposition_by_user: userId,
      disposition_at: new Date().toISOString(),
      disposition_note: parsed.data.note ?? null,
    })
    .eq('org_id', orgId)
    .eq('id', parsed.data.decision_id)
    .eq('status', 'PROPOSED');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
