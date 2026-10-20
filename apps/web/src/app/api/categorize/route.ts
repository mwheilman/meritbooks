export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { z } from 'zod';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { suggestCategory } from '@/lib/services/categorization';

const schema = z.object({
  description: z.string().min(3).max(2000),
  amount_cents: z.number().int().nonnegative(),
  location_id: z.string().uuid().nullable().optional(),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  // R0b — server-side authz. The AI Categorizer is a manual coding lane whose output is
  // posted as a JE (via the separately-guarded POST /api/journal-entries). Suggesting a
  // coding spends the org's AI budget and exposes the COA, so it carries the JE-create
  // gate. Fails closed (403).
  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  const apiKey = getAnthropicApiKey();
  if (!apiKey) return NextResponse.json({ error: 'AI is not configured (Anthropic key missing).' }, { status: 503 });

  const res = await suggestCategory(supabase, apiKey, {
    orgId,
    description: parsed.data.description,
    amountCents: parsed.data.amount_cents,
    locationId: parsed.data.location_id ?? null,
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.budgetBlocked ? 402 : 502 });
  }

  // Flat approved COA for the UI (expense-account override + "paid from" picker).
  const { data: accts } = await supabase
    .from('accounts')
    .select('id, account_number, name, account_type')
    .eq('org_id', orgId).eq('is_active', true).eq('approval_status', 'APPROVED')
    .order('account_number');

  return NextResponse.json({ suggestion: res.suggestion, accounts: accts ?? [] });
}
