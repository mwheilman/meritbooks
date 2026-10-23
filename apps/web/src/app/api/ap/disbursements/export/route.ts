export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireMoneyMovement, PAYMENTS_EXECUTE, AP_DISBURSEMENT_RELEASE_FEATURE } from '@/lib/rbac/payments-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { assembleApprovedBatch, heldSummary } from '@/lib/ap/assemble-batch';
import { buildDisbursementBatch } from '@/lib/ap/disbursement-batch';
import {
  toBillPayCsv,
  buildNachaFile,
  type NachaConfig,
  type NachaVendorInstruction,
} from '@/lib/ap/disbursement-export';

/**
 * Authorize (security MEDIUM): the export file IS the payment instruction the bank
 * executes, and it carries vendor names, amounts and remittance detail — so both
 * the download (GET) and the EXPORTED marker (POST) are gated exactly like
 * releasing the batch: the granular `ap_disbursement_release` money-movement key,
 * degrading to the coarse `payments` superset, then to checks:create (the same
 * chain as /api/ap/disbursements/release). Fails closed.
 */
function requireExportAuthority(userId: string) {
  return requireMoneyMovement(
    userId,
    PAYMENTS_EXECUTE,
    { feature: 'checks', action: 'create' },
    AP_DISBURSEMENT_RELEASE_FEATURE,
  );
}

/**
 * GET /api/ap/disbursements/export?format=csv|nacha — download the payment FILE.
 *
 * This is the ONLY "payment" output of the money-out MVP: a FILE the human
 * uploads to their bank. It NEVER moves money, NEVER posts to the GL, NEVER
 * contacts a bank or payment API, and — as of task #110 — NEVER writes anything:
 * a GET is a pure, side-effect-free read that serializes the approved batch and
 * returns it as a download. RLS scopes the read to the caller's org. The EXPORTED
 * audit marker is recorded by the explicit POST below, so downloads (which browsers
 * may prefetch/retry) can never mutate the audit trail.
 *
 * NACHA note: MeritBooks stores only MASKED bank details, so the ACH file is a
 * standards-shaped TEMPLATE with placeholder routing/account fields (surfaced via
 * the X-Export-Warnings header). The CSV bill-pay file is the reliable output.
 */
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requireExportAuthority(userId);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const format = (url.searchParams.get('format') ?? 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'nacha') {
    return NextResponse.json({ error: "format must be 'csv' or 'nacha'" }, { status: 400 });
  }

  let assembled;
  try {
    // Vendor holds are re-checked READ-ONLY: a bank change or compliance hold opened
    // after approval keeps that line out of the bank file.
    assembled = await assembleApprovedBatch(supabase, { holdCheck: { orgId } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Assembly failed' }, { status: 500 });
  }
  if (assembled.items.length === 0) {
    const why = heldSummary(assembled.held);
    return NextResponse.json({ error: why || 'No approved disbursements to export', held: assembled.held }, { status: 409 });
  }
  // Header values must be printable ASCII (vendor names can carry curly quotes etc.).
  const heldNote = heldSummary(assembled.held).replace(/[^\x20-\x7E]/g, '?');

  const batch = buildDisbursementBatch(assembled.items);
  const stamp = new Date().toISOString().slice(0, 10);

  // NOTE: the EXPORTED audit marker is NOT written here — a GET must be
  // side-effect-free. The client records it via POST /api/ap/disbursements/export
  // after the download succeeds.

  if (format === 'csv') {
    const csv = toBillPayCsv(batch, assembled.remittance);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="disbursements-${stamp}.csv"`,
        'Cache-Control': 'no-store',
        ...(heldNote ? { 'X-Export-Held': heldNote.slice(0, 900) } : {}),
      },
    });
  }

  // NACHA — env-configured header/company fields; safe placeholders when unset.
  const config: NachaConfig = {
    immediateDestination: process.env.NACHA_IMMEDIATE_DESTINATION ?? '000000000',
    immediateOrigin: process.env.NACHA_IMMEDIATE_ORIGIN ?? '0000000000',
    destinationName: process.env.NACHA_DESTINATION_NAME ?? 'RECEIVING BANK',
    originName: process.env.NACHA_ORIGIN_NAME ?? 'ORIGINATING COMPANY',
    companyName: process.env.NACHA_COMPANY_NAME ?? 'ORIGINATOR',
    companyId: process.env.NACHA_COMPANY_ID ?? '0000000000',
    effectiveDate: stamp,
  };
  // MeritBooks does not store full vendor bank numbers (only masks) — no
  // instructions are supplied, so the file is a placeholder template (warned).
  const instructions = new Map<string, NachaVendorInstruction>();
  const nacha = buildNachaFile(batch, config, instructions);

  return new NextResponse(nacha.text, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="disbursements-${stamp}.ach"`,
      'Cache-Control': 'no-store',
      'X-Export-Warnings': nacha.warnings.join(' | ').slice(0, 900),
      ...(heldNote ? { 'X-Export-Held': heldNote.slice(0, 900) } : {}),
    },
  });
}

/**
 * POST /api/ap/disbursements/export — record the EXPORTED audit marker.
 *
 * The write half of export, split out of GET so downloading a file (a read a
 * browser may prefetch or retry) never mutates the audit trail. The client calls
 * this once, after a successful download, to log that the batch's bank file was
 * exported. It NEVER moves money or posts to the GL. RLS scopes every read/write
 * to the caller's org.
 *
 * (Batch-level status is DRAFT→EXPORTED→RELEASED once the disbursement_batches
 * table lands; until then this human-action log records the EXPORTED step.)
 */
export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requireExportAuthority(userId);
  if (!guard.ok) return guard.response;

  let format = 'csv';
  try {
    const body = (await request.json()) as { format?: string };
    if (body.format === 'nacha' || body.format === 'csv') format = body.format;
  } catch {
    /* empty body -> default csv */
  }

  // Re-assemble (read-only, RLS-scoped) so the marker's counts are server-computed,
  // not client-supplied.
  let assembled;
  try {
    assembled = await assembleApprovedBatch(supabase, { holdCheck: { orgId } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Assembly failed' }, { status: 500 });
  }
  if (assembled.items.length === 0) {
    return NextResponse.json({ error: 'No approved disbursements to mark exported' }, { status: 409 });
  }
  const batch = buildDisbursementBatch(assembled.items);

  await logHumanAction(supabase, userId, orgId, {
    action: 'ap.disbursements.export',
    subjectTable: 'approvals',
    summary: `Exported ${format.toUpperCase()} disbursement file: ${batch.controls.itemCount} payment(s), ${(batch.controls.totalCents / 100).toFixed(2)} total`,
    metadata: {
      format,
      itemCount: batch.controls.itemCount,
      totalCents: batch.controls.totalCents,
      vendorCount: batch.controls.vendorCount,
      heldCount: assembled.held.length,
    },
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    itemCount: batch.controls.itemCount,
    totalCents: batch.controls.totalCents,
  });
}
