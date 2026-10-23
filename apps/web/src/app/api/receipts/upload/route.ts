export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { assertWriteScope, isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { requirePermission } from '@/lib/rbac/require-permission';
import { captureReceipt, CaptureError } from '@/lib/receipts/capture';
import { ASSIGNMENT_COLUMNS } from '@/lib/receipts/chase';
import { parseReceiptUpload } from '@/lib/receipts/upload-form';
import type { CardAssignmentRow } from '@/lib/receipts/types';

/**
 * POST /api/receipts/upload — desk drag-drop (one or many files) for ONE company.
 *
 * receipts:edit, then the company is checked against the caller's org + client scope
 * before the service role writes (receipts is member-locked, migration 172). Each file
 * runs the one capture pipeline: store → read (AI gateway or rules) → auto-match to the
 * company's open card charges. Optional `assignment_id` stamps the cardholder; optional
 * `transaction_id` attaches a single file to that charge.
 */
export async function POST(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId, supabase } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'receipts', 'edit', { route: '/api/receipts/upload' });
  if (!guard.ok) return guard.response;

  const up = await parseReceiptUpload(req);
  if (!up.ok) return NextResponse.json({ error: up.error }, { status: up.status });
  const locationId = up.fields.location_id;
  if (!locationId) return NextResponse.json({ error: 'Pick the company these receipts belong to.' }, { status: 422 });
  if (up.fields.transaction_id && up.files.length > 1) return NextResponse.json({ error: 'Attach one file at a time to a charge.' }, { status: 422 });

  try {
    await assertWriteScope(supabase, orgId, [locationId]);
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  const db = serviceWriter();
  let holder: CardAssignmentRow | null = null;
  if (up.fields.assignment_id) {
    const { data } = await db.from('card_assignments').select(ASSIGNMENT_COLUMNS).eq('org_id', orgId).eq('id', up.fields.assignment_id).eq('location_id', locationId).maybeSingle();
    holder = (data as CardAssignmentRow | null) ?? null;
    if (!holder) return NextResponse.json({ error: 'That cardholder was not found for this company.' }, { status: 404 });
  }

  const deps = { db, now: () => new Date(), anthropicApiKey: getAnthropicApiKey() };
  const results: Array<Record<string, unknown>> = [];
  for (const f of up.files) {
    if (f.error) {
      results.push({ fileName: f.file.fileName, ok: false, error: f.error });
      continue;
    }
    try {
      const r = await captureReceipt(deps, {
        orgId,
        locationId,
        source: 'MANUAL_UPLOAD',
        file: f.file,
        holder,
        chargeId: up.fields.transaction_id ?? null,
        memo: up.fields.memo ?? null,
        jobId: up.fields.job_id ?? null,
        typed: up.files.length === 1 ? { merchant: up.fields.merchant ?? null, amountCents: up.amountCents, date: up.fields.date ?? null } : undefined,
        submittedBy: userId,
      });
      results.push({
        fileName: f.file.fileName,
        ok: true,
        receiptId: r.receiptId,
        duplicate: r.duplicate,
        match: r.match.kind,
        transactionId: 'transactionId' in r.match ? r.match.transactionId : null,
        merchant: r.facts.merchant,
        amountCents: r.facts.totalCents,
        date: r.facts.date,
        read: r.facts.source,
      });
    } catch (e) {
      if (e instanceof CaptureError) results.push({ fileName: f.file.fileName, ok: false, error: e.message });
      else {
        console.error('[receipts/upload]', e);
        results.push({ fileName: f.file.fileName, ok: false, error: 'Something went wrong saving this file.' });
      }
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({ results, saved: okCount, failed: results.length - okCount }, { status: okCount > 0 ? 201 : 400 });
}
