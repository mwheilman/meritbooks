export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { composeJournalEntry, type ComposerAccount } from '@/lib/services/je-composer';
import { z } from 'zod';

const schema = z.object({
  description: z.string().min(3).max(2000),
  location_id: z.string().uuid(),
});

/**
 * POST /api/journal-entries/compose
 * Advisory: returns a PROPOSED balanced entry for human review. Does not post.
 */
export async function POST(request: Request) {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured.', code: 'NO_API_KEY' }, { status: 503 });
  }

  let body: z.infer<typeof schema>;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues.map((i) => i.message) }, { status: 422 });
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const supabase = createAdminSupabase();

  // Resolve org + company from the location.
  const { data: loc } = await supabase
    .schema('core').from('locations')
    .select('id, name, org_id')
    .eq('id', body.location_id)
    .single();
  if (!loc) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  const orgId = (loc as { org_id: string }).org_id;

  // Pull the approved chart of accounts for this org.
  const { data: accts, error: acctErr } = await supabase
    .from('accounts')
    .select('id, account_number, name, account_type, account_sub_type, is_control_account, is_active, approval_status')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .eq('approval_status', 'APPROVED')
    .order('account_number');

  if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 });

  const usable = (accts ?? []).filter((a) => !(a as { is_control_account: boolean }).is_control_account);
  if (usable.length === 0) {
    return NextResponse.json({ error: 'No usable accounts found. Seed the chart of accounts first.', code: 'NO_COA' }, { status: 422 });
  }

  const idByNumber = new Map(usable.map((a) => [String((a as { account_number: string }).account_number), (a as { id: string }).id]));
  const composerAccounts: ComposerAccount[] = usable.map((a) => ({
    account_number: String((a as { account_number: string }).account_number),
    name: String((a as { name: string }).name),
    account_type: String((a as { account_type: string }).account_type),
    account_sub_type: String((a as { account_sub_type: string }).account_sub_type),
  }));

  const result = await composeJournalEntry(body.description, composerAccounts, apiKey, (loc as { name: string }).name);

  if (!result.success || !result.proposal) {
    return NextResponse.json({ error: result.error ?? 'Compose failed' }, { status: 502 });
  }

  // Map account numbers -> ids; flag any the model invented (shouldn't happen).
  const unresolved: string[] = [];
  const lines = result.proposal.lines.map((l) => {
    const account_id = idByNumber.get(l.account_number) ?? null;
    if (!account_id) unresolved.push(l.account_number);
    return {
      account_id,
      account_number: l.account_number,
      account_label: account_id
        ? `${l.account_number} · ${composerAccounts.find((a) => a.account_number === l.account_number)?.name ?? ''}`
        : `${l.account_number} (not found)`,
      debit_cents: l.debit_cents,
      credit_cents: l.credit_cents,
      memo: l.memo,
    };
  });

  // Best-effort audit log (never block the response on logging).
  try {
    await supabase.from('ai_audit_log').insert({
      org_id: orgId,
      feature: 'JE_COMPOSER',
      model_version: 'claude-sonnet-4-20250514',
      input_summary: body.description.slice(0, 500),
      output_summary: result.proposal.memo.slice(0, 500),
      confidence: result.proposal.confidence,
      tokens_input: result.tokensInput ?? null,
      tokens_output: result.tokensOutput ?? null,
      latency_ms: result.latencyMs ?? null,
    });
  } catch (e) {
    console.error('[je-compose] audit log failed (non-fatal):', e);
  }

  return NextResponse.json({
    proposal: {
      memo: result.proposal.memo,
      lines,
      balanced: result.proposal.balanced && unresolved.length === 0,
      totalDebitCents: result.proposal.totalDebitCents,
      totalCreditCents: result.proposal.totalCreditCents,
      prediction: result.proposal.prediction,
      confidence: result.proposal.confidence,
      clarifyingQuestion: result.proposal.clarifyingQuestion,
      notes: result.proposal.notes,
      unresolvedAccounts: unresolved,
    },
  });
}
