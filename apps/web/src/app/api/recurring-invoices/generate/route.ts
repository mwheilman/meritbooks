export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // auto-send renders a PDF via @react-pdf/renderer

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { generateDueRecurringInvoices } from '@/lib/invoices/recurring-invoices';

/**
 * POST /api/recurring-invoices/generate — generate every due recurring invoice.
 *
 * Finds active templates whose next_run_date has arrived (occurrences/end not
 * exhausted) and, for each, creates a real invoice through the shared create core
 * (mint number → lines → rev-rec-aware GL post), advances next_run_date by the
 * cadence, and — where auto_send is on and email is configured — emails it.
 * Idempotent: re-running the same day is a no-op because next_run_date advances
 * past today. Optionally scope to one template (`template_id`) for "run now".
 *
 * Gated on invoices:create (this creates real AR).
 */
const schema = z.object({
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  template_id: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues }, { status: 422 });
  }

  const supabase = createAdminSupabase();
  try {
    const result = await generateDueRecurringInvoices(
      supabase,
      orgId,
      parsed.data.as_of ?? new Date().toISOString().slice(0, 10),
      { templateId: parsed.data.template_id },
    );
    return NextResponse.json(result);
  } catch (e) {
    console.error('[recurring generate]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Generation failed' }, { status: 500 });
  }
}
