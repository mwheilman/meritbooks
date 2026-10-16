export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { requireAuth } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';
import { z } from 'zod';
import { requirePermission } from '@/lib/rbac/require-permission';
import type { SupabaseClient } from '@supabase/supabase-js';

const updateTransactionSchema = z.object({
  final_account_id: z.string().uuid().optional(),
  final_department_id: z.string().uuid().nullable().optional(),
  final_class_id: z.string().uuid().nullable().optional(),
  final_vendor_id: z.string().uuid().nullable().optional(),
  final_job_id: z.string().uuid().nullable().optional(),
});

type RefField = 'final_account_id' | 'final_department_id' | 'final_class_id' | 'final_vendor_id' | 'final_job_id';

/** Where each referenced id must live — every one is org-owned. */
const REF_TABLES: Record<RefField, { schema: 'public' | 'core'; table: string; label: string }> = {
  final_account_id: { schema: 'public', table: 'accounts', label: 'GL account' },
  final_department_id: { schema: 'core', table: 'departments', label: 'Department' },
  final_class_id: { schema: 'public', table: 'classes', label: 'Class' },
  final_vendor_id: { schema: 'core', table: 'vendors', label: 'Vendor' },
  final_job_id: { schema: 'core', table: 'jobs', label: 'Job' },
};

/**
 * Security (MEDIUM): this route writes through the ADMIN client (RLS bypassed), so
 * a foreign-key id from ANOTHER tenant would be accepted by Postgres (FKs don't
 * check org) and then echoed back — a cross-tenant write + label leak. Every
 * provided reference must resolve to a row in the caller's verified org.
 * Returns the first offending field's label, or null when all are in-org.
 */
async function firstForeignReference(
  supabase: SupabaseClient,
  orgId: string,
  body: Partial<Record<RefField, string | null>>,
): Promise<string | null> {
  for (const field of Object.keys(REF_TABLES) as RefField[]) {
    const id = body[field];
    if (typeof id !== 'string') continue; // undefined (untouched) or null (cleared)
    const ref = REF_TABLES[field];
    const base = ref.schema === 'core' ? supabase.schema('core').from(ref.table) : supabase.from(ref.table);
    const { data, error } = await base.select('id').eq('id', id).eq('org_id', orgId).maybeSingle();
    if (error || !data) return ref.label;
  }
  return null;
}

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

  // Auth — fail closed.
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  // Authorize — recoding a bank line (GL account / dimensions / vendor / job) is a
  // bank-feed edit. This route uses the ADMIN client, so every read/write below is
  // also pinned to the caller's VERIFIED org (no cross-tenant edit by id).
  const guard = await requirePermission(userId, 'bank_feed', 'edit');
  if (!guard.ok) return guard.response;
  const scopedOrgId = guard.orgId;

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
      .select('id, status, gl_entry_id, description, final_account_id, final_department_id, final_class_id, final_vendor_id, final_job_id, ai_vendor_id')
      .eq('id', txnId)
      .eq('org_id', scopedOrgId)
      .single();

    if (fetchError || !current) {
      return NextResponse.json(
        { error: 'Transaction not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    // A line that has already POSTED to the GL is booked — recoding the row would
    // desync it from its journal entry. Corrections go through the GL (void /
    // reverse), not an inline edit.
    if (current.status === 'POSTED' || current.gl_entry_id) {
      return NextResponse.json(
        { error: 'This transaction has already posted to the general ledger and can no longer be edited here. Void or reverse its journal entry instead.', code: 'ALREADY_POSTED' },
        { status: 409 }
      );
    }

    // Every referenced account / department / class / vendor / job must belong
    // to the caller's org (the admin client won't enforce it).
    const foreign = await firstForeignReference(supabase, scopedOrgId, body);
    if (foreign) {
      return NextResponse.json(
        { error: `${foreign} not found`, code: 'INVALID_REFERENCE' },
        { status: 422 }
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
      .eq('org_id', scopedOrgId)
      .neq('status', 'POSTED')
      .is('gl_entry_id', null)
      .select(`
        id, status,
        final_account:accounts!bank_transactions_final_account_id_fkey(id, account_number, name, account_type),
        final_job_id
      `)
      .single();

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message, code: 'UPDATE_ERROR' },
        { status: 500 }
      );
    }

    // Stitch final_job (core) onto the response — cross-schema embeds don't work.
    // Only an in-org job's label is ever returned (the id was validated above; the
    // org check here is defense in depth against a legacy cross-tenant value).
    if (updated) {
      const u = updated as { final_job_id?: string | null; final_job?: { id: string; job_number: string; name: string } | null };
      const jobMap = await fetchCoreMap<{ id: string; job_number: string; name: string; org_id: string }>(
        supabase, 'jobs', 'id, job_number, name, org_id', [u.final_job_id]);
      const job = u.final_job_id ? jobMap.get(u.final_job_id) ?? null : null;
      u.final_job = job && job.org_id === scopedOrgId
        ? { id: job.id, job_number: job.job_number, name: job.name }
        : null;
    }

    // Audit log all changed fields
    if (changedFields.length > 0) {
      const auditEntries = changedFields.map((c) => ({
        org_id: scopedOrgId,
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
        org_id: scopedOrgId,
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
