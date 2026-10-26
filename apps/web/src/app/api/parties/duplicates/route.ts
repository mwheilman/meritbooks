export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * The ONE duplicate review queue for Books and Projects (core.duplicate_reviews, Projects 1111):
 * pairs the safety net (or the door) filed as possible duplicates.
 *
 *   GET  ?kind=customer|vendor        open reviews with both records' names and where they are used
 *   POST { action: 'dismiss', review_id }                      → core.dismiss_duplicate (never suggested again)
 *   POST { action: 'merge', review_id, survivor_id }           → core.merge_parties (repoints every reference;
 *                                                                 money settings that differ are refused
 *                                                                 by the RPC with its reason)
 *
 * Every call runs AS THE CALLER — the RPCs enforce org, the edit capability on both records, and
 * the Books money-field authority. customers:edit / vendors:edit gate the writes here too.
 */

const querySchema = z.object({ kind: z.enum(['customer', 'vendor']).default('customer') });

interface ReviewRow {
  id: string; kind: 'customer' | 'vendor'; a_id: string; b_id: string; suggested_survivor_id: string | null;
  score: number | string; matched: string[] | null; source: string; created_at: string;
}

export const GET = apiQueryHandler(querySchema, async (q, { userId, orgId, supabase }) => {
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, q.kind === 'vendor' ? 'vendors' : 'customers', 'view', { route: '/api/parties/duplicates' });
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase.schema('core').from('duplicate_reviews')
    .select('id, kind, a_id, b_id, suggested_survivor_id, score, matched, source, created_at')
    .eq('org_id', orgId).eq('kind', q.kind).eq('status', 'open').order('score', { ascending: false }).limit(200);
  if (error) {
    // 1111 not deployed: an empty queue, not an error page.
    if (/duplicate_reviews/.test(error.message) && /does not exist|schema cache/i.test(error.message)) return NextResponse.json({ available: false, reviews: [] });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const reviews = (data ?? []) as ReviewRow[];
  const ids = [...new Set(reviews.flatMap((r) => [r.a_id, r.b_id]))];
  const names = new Map<string, { name: string; email: string | null; city: string | null; created_at: string | null }>();
  if (ids.length > 0) {
    const { data: parties } = await supabase.schema('core').from(q.kind === 'vendor' ? 'vendors' : 'customers')
      .select('id, name, display_name, email, city, created_at').in('id', ids);
    for (const p of (parties ?? []) as Array<{ id: string; name: string; display_name: string | null; email: string | null; city: string | null; created_at: string | null }>) {
      names.set(p.id, { name: p.display_name || p.name, email: p.email, city: p.city, created_at: p.created_at });
    }
  }
  return NextResponse.json({
    available: true,
    reviews: reviews.map((r) => ({
      id: r.id,
      kind: r.kind,
      score: Number(r.score),
      matched: r.matched ?? [],
      source: r.source,
      created_at: r.created_at,
      suggested_survivor_id: r.suggested_survivor_id,
      a: { id: r.a_id, ...(names.get(r.a_id) ?? { name: 'Record not visible', email: null, city: null, created_at: null }) },
      b: { id: r.b_id, ...(names.get(r.b_id) ?? { name: 'Record not visible', email: null, city: null, created_at: null }) },
    })),
  });
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dismiss'), review_id: z.string().uuid(), kind: z.enum(['customer', 'vendor']).default('customer') }),
  z.object({ action: z.literal('merge'), review_id: z.string().uuid(), survivor_id: z.string().uuid(), kind: z.enum(['customer', 'vendor']).default('customer') }),
]);

export const POST = apiHandler(actionSchema, async (b, { userId, orgId, supabase }) => {
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, b.kind === 'vendor' ? 'vendors' : 'customers', 'edit', { route: '/api/parties/duplicates' });
  if (!guard.ok) return guard.response;

  if (b.action === 'dismiss') {
    const { error } = await supabase.schema('core').rpc('dismiss_duplicate', { p_review: b.review_id });
    if (error) return NextResponse.json({ error: error.message.replace(/^CORE_[A-Z_]+:\s*/, '') }, { status: error.code === '42501' ? 403 : 422 });
    return NextResponse.json({ ok: true, status: 'not_duplicate' });
  }

  const { data: review } = await supabase.schema('core').from('duplicate_reviews').select('id, kind, a_id, b_id, status')
    .eq('org_id', orgId).eq('id', b.review_id).maybeSingle();
  const r = review as { id: string; kind: string; a_id: string; b_id: string; status: string } | null;
  if (!r) return NextResponse.json({ error: 'Review not found' }, { status: 404 });
  if (r.status !== 'open') return NextResponse.json({ error: `This pair is already ${r.status.replace('_', ' ')}` }, { status: 409 });
  if (b.survivor_id !== r.a_id && b.survivor_id !== r.b_id) return NextResponse.json({ error: 'The record to keep must be one of the pair' }, { status: 422 });
  const victim = b.survivor_id === r.a_id ? r.b_id : r.a_id;
  const { data, error } = await supabase.schema('core').rpc('merge_parties', {
    p_kind: r.kind, p_survivor: b.survivor_id, p_victim: victim, p_field_choices: {},
  });
  if (error) return NextResponse.json({ error: error.message.replace(/^CORE_[A-Z_]+:\s*/, '') }, { status: error.code === '42501' ? 403 : 422 });
  return NextResponse.json({ ok: true, status: 'merged', summary: data });
});
