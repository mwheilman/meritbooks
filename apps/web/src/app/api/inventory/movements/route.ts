export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { PostingError } from '@/lib/posting/account-roles';
import { receiveInventory, proposeMovement } from '@/lib/inventory/inventory-service';

/**
 * POST /api/inventory/movements — create an inventory movement.
 *
 *   RECEIPT → recorded immediately (valuation only, no GL).
 *   ISSUE / ADJUST → created PROPOSED with a COGS preview; a human posts the GL via
 *                    /api/inventory/movements/[id]/approve (canon §3: no auto-post).
 *
 * RLS-scoped. Gated on 'fixed_assets' create until a dedicated 'inventory' permission
 * exists (REPORTED to the lead).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const bodySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('RECEIPT'),
    item_id: z.string().uuid(),
    qty: z.number().positive(),
    total_cost_cents: z.number().int().nonnegative(),
    movement_date: z.string().regex(DATE_RE).optional(),
    reference: z.string().max(200).optional(),
    ref_type: z.enum(['BILL', 'PO', 'MANUAL']).optional(),
    ref_id: z.string().uuid().optional(),
    memo: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('ISSUE'),
    item_id: z.string().uuid(),
    qty: z.number().positive(),
    movement_date: z.string().regex(DATE_RE).optional(),
    reference: z.string().max(200).optional(),
    memo: z.string().max(500).optional(),
    // Optional linkage: attach the issue to a job (job cost) OR an invoice line.
    // COGS still posts BY ROLE through the human-gated approve path.
    job_id: z.string().uuid().optional(),
    invoice_id: z.string().uuid().optional(),
    invoice_line_id: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal('ADJUST'),
    item_id: z.string().uuid(),
    // signed delta: positive = write-up (needs unit_cost_cents), negative = shrinkage
    qty: z.number().refine((n) => n !== 0, 'Adjustment quantity cannot be zero'),
    unit_cost_cents: z.number().int().nonnegative().optional(),
    movement_date: z.string().regex(DATE_RE).optional(),
    reference: z.string().max(200).optional(),
    memo: z.string().max(500).optional(),
  }),
]);

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'fixed_assets', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '_root';
      (details[path] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details }, { status: 422 });
  }
  const body = parsed.data;
  const date = body.movement_date ?? new Date().toISOString().slice(0, 10);

  try {
    if (body.type === 'RECEIPT') {
      const result = await receiveInventory(supabase, {
        orgId,
        itemId: body.item_id,
        qty: body.qty,
        totalCostCents: body.total_cost_cents,
        receivedDate: date,
        reference: body.reference ?? null,
        refType: body.ref_type ?? 'MANUAL',
        refId: body.ref_id ?? null,
        memo: body.memo ?? null,
        createdBy: null,
      });
      await logHumanAction(supabase, userId, orgId, {
        action: 'inventory_movement.receipt',
        subjectTable: 'inventory_movements',
        subjectId: result.movement_id,
        summary: `Received ${body.qty} into inventory (${(body.total_cost_cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })})`,
      });
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }

    if (body.type === 'ADJUST' && body.qty > 0 && body.unit_cost_cents === undefined) {
      return NextResponse.json(
        { error: 'A positive adjustment (write-up) requires unit_cost_cents.', code: 'MISSING_COST' },
        { status: 422 },
      );
    }

    const result = await proposeMovement(supabase, {
      orgId,
      itemId: body.item_id,
      type: body.type,
      qty: body.qty,
      unitCostCents: body.type === 'ADJUST' ? body.unit_cost_cents : undefined,
      movementDate: date,
      reference: body.reference ?? null,
      memo: body.memo ?? null,
      createdBy: null,
      ...(body.type === 'ISSUE'
        ? {
            jobId: body.job_id ?? null,
            invoiceId: body.invoice_id ?? null,
            invoiceLineId: body.invoice_line_id ?? null,
          }
        : {}),
    });
    await logHumanAction(supabase, userId, orgId, {
      action: `inventory_movement.propose_${body.type.toLowerCase()}`,
      subjectTable: 'inventory_movements',
      subjectId: result.movement_id,
      summary: `Proposed ${body.type} of ${body.qty} (COGS preview ${(result.cogs_cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })})`,
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Movement failed', code: 'MOVEMENT_ERROR' },
      { status },
    );
  }
}
