export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

const updateTransactionSchema = z.object({
  final_account_id: z.string().uuid().optional(),
  final_department_id: z.string().uuid().nullable().optional(),
  final_class_id: z.string().uuid().nullable().optional(),
  final_vendor_id: z.string().uuid().nullable().optional(),
  final_job_id: z.string().uuid().nullable().optional(),
});

/**
 * PATCH /api/bank-feed/[id]
 * Inline update for a single bank transaction.
 * Used when the accountant changes the GL category or job directly from the table row.
 *
 * Side effects:
 * - PENDING → CATEGORIZED when account is assigned
 * - Updates vendor_patterns for future AI learning
 * - All changes are audit-logged
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: txnId } = await params;

  // Auth
  const authResult = await auth().catch(() => ({
    userId: null as string | null,
    orgId: null as string | null,
  }));
  const userId = authResult.userId ?? 'dev-user';
  const orgId = authResult.orgId ?? null;

  try {
    const raw = await request.json();
    const result = updateTransactionSchema.safeParse(raw);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', code: 'VALIDATION_ERROR' },
        { status: 422 }
      );
    }

    const body = result.data;
    const supabase = createAdminSupabase();

    // Fetch current values for audit trail
    const { data: current, error: fetchError } = await supabase
      .from('bank_transactions')
      .select('id, status, description, final_account_id, final_department_id, final_class_id, final_vendor_id, final_job_id, ai_vendor_id')
      .eq('id', txnId)
      .single();

    if (fetchError || !current) {
      return NextResponse.json(
        { error: 'Transaction not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    // Build update object with only provided fields
    const update: Record<string, unknown> = {};
    const changedFields: { field: string; oldVal: unknown; newVal: unknown }[] = [];

    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) {
        update[key] = value;
        const oldVal = (current as Record<string, unknown>)[key];
        if (oldVal !== value) {
          changedFields.push({ field: key, oldVal: oldVal ?? null, newVal: value });
        }
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: 'No fields to update', code: 'NO_CHANGES' },
        { status: 400 }
      );
    }

    // Auto-promote: PENDING → CATEGORIZED when account is assigned
    if (current.status === 'PENDING' && update.final_account_id) {
      update.status = 'CATEGORIZED';
      changedFields.push({ field: 'status', oldVal: 'PENDING', newVal: 'CATEGORIZED' });
    }

    // Execute update
    const { data: updated, error: updateError } = await supabase
      .from('bank_transactions')
      .update(update)
      .eq('id', txnId)
      .select(`
        id, status,
        final_account:accounts!bank_transactions_final_account_id_fkey(id, account_number, name, account_type),
        final_job:jobs!bank_transactions_final_job_id_fkey(id, job_number, name)
      `)
      .single();

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message, code: 'UPDATE_ERROR' },
        { status: 500 }
      );
    }

    // Audit log all changed fields
    if (changedFields.length > 0) {
      const auditEntries = changedFields.map((c) => ({
        org_id: orgId ?? undefined,
        table_name: 'bank_transactions',
        record_id: txnId,
        action: 'UPDATE' as const,
        field_name: c.field,
        old_value: c.oldVal != null ? String(c.oldVal) : null,
        new_value: c.newVal != null ? String(c.newVal) : null,
        user_id: userId,
      }));

      await supabase.from('audit_log').insert(auditEntries);
    }

    // Update vendor pattern cache for AI learning
    const vendorId = (update.final_vendor_id as string) ?? current.final_vendor_id ?? current.ai_vendor_id;
    const accountId = (update.final_account_id as string) ?? current.final_account_id;

    if (vendorId && accountId && current.description) {
      const normalized = current.description.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

      await supabase.from('vendor_patterns').upsert({
        org_id: orgId ?? undefined,
        vendor_id: vendorId,
        raw_description: current.description,
        normalized_description: normalized,
        account_id: accountId,
        department_id: (update.final_department_id as string) ?? current.final_department_id ?? null,
        class_id: (update.final_class_id as string) ?? current.final_class_id ?? null,
        match_count: 1,
        last_matched_at: new Date().toISOString(),
      }, {
        onConflict: 'org_id,vendor_id,normalized_description',
      });
    }

    return NextResponse.json({
      success: true,
      transaction: updated,
      changed: changedFields.map((c) => c.field),
    });
  } catch (err) {
    console.error('[PATCH bank-feed]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}
