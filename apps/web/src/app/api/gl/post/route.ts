export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { postJournalEntrySchema } from '@/lib/validations/gl';
import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';
import { logHumanAction } from '@/lib/trust/action-log';
import { resolveOrgId, PostingError } from '@/lib/posting';

export async function POST(request: Request) {
  // 1. Authenticate — fail CLOSED. No 'dev-user' fallback: an auth failure must
  //    never resolve to a privileged identity running the RLS-bypassing client.
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId, orgId } = authResult;

  // Never post with an empty org. Reject fast on a missing tenant claim rather than
  // handing the posting service `org_id: ''` (which would be an unscoped write).
  if (!orgId) {
    return NextResponse.json({ error: 'No organization on request', code: 'NO_ORG' }, { status: 400 });
  }

  // 2. Authorize — REFERENCE PATTERN for guarding money/mutation routes.
  //    Posting a journal entry requires journal_entries:post. Copy these two
  //    lines into every mutating route with the appropriate (feature, action)
  //    from lib/rbac/permissions.ts. (Follow-up: wire the remaining routes once
  //    the identity/org-resolution FPB lands — see require-permission.ts TODO.)
  const guard = await requirePermission(userId, 'journal_entries', 'post');
  if (!guard.ok) return guard.response;

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

    // Resolve the tenant claim through the shared resolver (uuid passthrough or
    // Clerk-org → Books tenant), consistent with the deposit/lifecycle routes.
    // Fails closed on an absent/unmapped claim — never posts to an arbitrary tenant.
    let resolvedOrgId: string;
    try {
      resolvedOrgId = await resolveOrgId(supabase, orgId);
    } catch (e) {
      const msg = e instanceof PostingError ? e.message : 'Could not resolve organization';
      return NextResponse.json({ error: msg, code: 'NO_ORG' }, { status: 400 });
    }

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
      org_id: resolvedOrgId,
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

    if (resolvedOrgId) {
      await logHumanAction(supabase, userId, resolvedOrgId, {
        action: 'gl.post',
        subjectTable: 'gl_entries',
        subjectId: postResult.entry_id ?? null,
        summary: `Posted journal entry ${postResult.entry_number ?? body.memo ?? ''}`.trim(),
        locationId: body.location_id,
      });
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
