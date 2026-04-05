export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { postJournalEntrySchema } from '@/lib/validations/gl';
import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';

export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const userId = authResult.userId ?? 'dev-user';
  const orgId = authResult.orgId ?? null;

  try {
    const raw = await request.json();
    const result = postJournalEntrySchema.safeParse(raw);

    if (!result.success) {
      const errors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '_root';
        if (!errors[path]) errors[path] = [];
        errors[path].push(issue.message);
      }
      return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: errors }, { status: 422 });
    }

    const body = result.data;
    const supabase = createAdminSupabase();

    // Map lines: convert null to undefined for JournalEntryLineInput compatibility
    const lines: JournalEntryLineInput[] = body.lines.map((l) => ({
      account_id: l.account_id,
      debit_cents: l.debit_cents,
      credit_cents: l.credit_cents,
      location_id: l.location_id,
      department_id: l.department_id ?? undefined,
      class_id: l.class_id ?? undefined,
      item_id: l.item_id ?? undefined,
      memo: l.memo ?? undefined,
      quantity: l.quantity ?? undefined,
      unit_cost_cents: l.unit_cost_cents ?? undefined,
    }));

    const postResult = await postJournalEntry(supabase, {
      org_id: orgId ?? '',
      location_id: body.location_id,
      entry_date: body.entry_date,
      entry_type: body.entry_type,
      memo: body.memo,
      source_module: body.source_module ?? 'MANUAL',
      source_id: body.source_id,
      created_by: userId,
      lines,
    });

    if (!postResult.success) {
      return NextResponse.json({ error: postResult.error, code: 'POST_FAILED' }, { status: 400 });
    }

    return NextResponse.json(postResult, { status: 201 });
  } catch (error) {
    console.error('[GL Post Error]', error);
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
