export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { emitDeptInvoiceIssue } from '@/lib/services/dept-invoice-events';
import { z } from 'zod';

/**
 * Projects → Books seam entry point. Represents the Projects module emitting a
 * DEPT_INVOICE_ISSUE after the receiver department head approves the internal
 * invoice in Projects. Writes only the core.events row (entitlement-gated);
 * Books consumes it at /api/events/dept-invoice/process.
 */
const schema = z.object({
  location_id: z.string().uuid(),
  provider_department_id: z.string().uuid(),
  receiver_department_id: z.string().uuid(),
  occurred_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source_ref: z.string().min(1).max(200),
  projects_document_id: z.string().min(1).max(200),
  memo: z.string().max(1000).optional().nullable(),
  lines: z.array(z.object({
    description: z.string().min(1).max(300),
    amount_cents: z.number().int().positive(),
    item_id: z.string().uuid().optional().nullable(),
  })).min(1),
});

export async function POST(request: Request) {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof schema>;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, { status: 422 });
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const supabase = createAdminSupabase();
  const { data: loc } = await supabase.schema('core').from('locations').select('org_id').eq('id', body.location_id).maybeSingle();
  const orgId = (loc as { org_id: string } | null)?.org_id ?? null;
  if (!orgId) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  try {
    const eventId = await emitDeptInvoiceIssue(supabase, {
      orgId,
      locationId: body.location_id,
      providerDepartmentId: body.provider_department_id,
      receiverDepartmentId: body.receiver_department_id,
      occurredOn: body.occurred_on,
      sourceRef: body.source_ref,
      lines: body.lines,
      memo: body.memo ?? null,
      projectsDocumentId: body.projects_document_id,
    });
    return NextResponse.json({ ok: true, event_id: eventId, event_type: 'DEPT_INVOICE_ISSUE', status: 'pending' }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Emit failed' }, { status: 422 });
  }
}
