export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { buildReadinessReport } from '@/app/api/compliance/1099/readiness';
import {
  assembleForm1099Batch,
  slugify,
  type PayerInfo,
  type RecipientInput,
} from '@/lib/tax/form-1099';
import { buildFireFile, type FireTransmitter } from '@/lib/tax/1099/fire-file';

/**
 * IRS FIRE electronic-file generation for Form 1099-NEC — the fixed-width
 * (Publication 1220) transmittal the IRS FIRE system ingests. This complements the
 * existing generate route, which emits filing-service import CSV + recipient Copy B
 * PDFs; this route emits the IRS's own T/A/B/C/F record file.
 *
 * FILE ONLY — canon §3. This endpoint READS the owned ledger and RENDERS a file for
 * download. It NEVER contacts the IRS, never transmits, never writes the ledger, and
 * never moves money. A human uploads the file to FIRE.
 *
 * GET /api/tax/1099/efile?year=YYYY&format=summary|fire
 *   Payer params (mirror the generate route):
 *     payerName, payerTin, payerAddress1, payerAddress2, payerCity, payerState, payerZip, payerPhone
 *   Transmitter params (default: transmitter = payer; TCC from IRS_FIRE_TCC env):
 *     tcc, transmitterTin, transmitterName, contactName, contactPhone, contactEmail, test=1
 *
 *   summary (default) — JSON { readyCount, blockers[], warnings[], hasPlaceholders, payerTinMissing }.
 *                       The pre-download review: what will be filed, what is BLOCKED
 *                       (missing TIN/W-9, excluded by construction), and the config
 *                       gaps (TCC / transmitter TIN) that make the file non-transmittable.
 *   fire    — the fixed-width .txt e-file as an attachment. Only READY records become
 *             B (payee) records; a blocked contractor can never reach the file.
 *
 * Gated on the same permission as the 1099 readiness surface (compliance:view), which
 * already exposes vendor tax facts + payment totals. RLS-scoped — the DB enforces org
 * isolation; this route never filters org_id by hand.
 */

const CURRENT_YEAR = new Date().getFullYear();

function param(sp: URLSearchParams, key: string): string | null {
  const v = sp.get(key);
  return v && v.trim().length > 0 ? v.trim() : null;
}

function parseRemitTo(remit: string | null): {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const empty = { line1: null, line2: null, city: null, state: null, zip: null };
  if (!remit) return empty;
  const linesArr = remit
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (linesArr.length === 0) return empty;
  const last = linesArr[linesArr.length - 1];
  const m = last.match(/^(.+?),?\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (m && linesArr.length >= 1) {
    return {
      line1: linesArr[0] ?? null,
      line2: linesArr.length > 2 ? linesArr[1] : null,
      city: m[1].replace(/,$/, '').trim(),
      state: m[2].toUpperCase(),
      zip: m[3],
    };
  }
  return { line1: linesArr[0] ?? null, line2: linesArr[1] ?? null, city: null, state: null, zip: null };
}

export async function GET(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }
  const guard = await requirePermission(userId, 'compliance', 'view');
  if (!guard.ok) return guard.response;

  const sp = req.nextUrl.searchParams;
  const yearRaw = Number(sp.get('year'));
  const year =
    Number.isInteger(yearRaw) && yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : CURRENT_YEAR;
  const format = (sp.get('format') || 'summary').toLowerCase();

  // 1. Readiness = the candidate list + per-vendor reportable (non-card) totals.
  const readiness = await buildReadinessReport(supabase, year);
  const vendorIds = readiness.rows.map((r) => r.vendorId);

  // 2. Recipient address + TIN for candidates (RLS-scoped core.vendors).
  const vendorDetail = new Map<
    string,
    { tin: string | null; line1: string | null; line2: string | null; city: string | null; state: string | null; zip: string | null }
  >();
  for (let i = 0; i < vendorIds.length; i += 500) {
    const slice = vendorIds.slice(i, i + 500);
    if (slice.length === 0) break;
    const { data: vRows } = await supabase
      .schema('core')
      .from('vendors')
      .select('id, tin_encrypted, address_line1, address_line2, city, state, zip')
      .in('id', slice);
    for (const v of (vRows ?? []) as Array<Record<string, unknown>>) {
      vendorDetail.set(String(v.id), {
        tin: (v.tin_encrypted as string) ?? null,
        line1: (v.address_line1 as string) ?? null,
        line2: (v.address_line2 as string) ?? null,
        city: (v.city as string) ?? null,
        state: (v.state as string) ?? null,
        zip: (v.zip as string) ?? null,
      });
    }
  }

  // 3. Payer info — params first, then org name + invoice-template remit-to.
  const [{ data: org }, { data: tmpl }] = await Promise.all([
    supabase.schema('core').from('organizations').select('name').eq('id', orgId).maybeSingle(),
    supabase
      .from('invoice_templates')
      .select('remit_to')
      .eq('org_id', orgId)
      .limit(1)
      .maybeSingle(),
  ]);
  const orgName = (org as { name?: string } | null)?.name ?? 'Payer';
  const remit = parseRemitTo((tmpl as { remit_to?: string } | null)?.remit_to ?? null);

  const payer: PayerInfo = {
    name: param(sp, 'payerName') ?? orgName,
    tin: param(sp, 'payerTin'),
    addressLine1: param(sp, 'payerAddress1') ?? remit.line1,
    addressLine2: param(sp, 'payerAddress2') ?? remit.line2,
    city: param(sp, 'payerCity') ?? remit.city,
    state: param(sp, 'payerState') ?? remit.state,
    zip: param(sp, 'payerZip') ?? remit.zip,
    phone: param(sp, 'payerPhone'),
  };

  // 4. Assemble recipient inputs and the batch.
  const recipients: RecipientInput[] = readiness.rows.map((r) => {
    const d = vendorDetail.get(r.vendorId);
    return {
      vendorId: r.vendorId,
      vendorName: r.vendorName,
      totalPaidCents: r.totalPaidCents,
      paymentCount: r.paymentCount,
      is1099Eligible: r.is1099Eligible,
      w9Status: r.w9Status,
      tin: d?.tin ?? null,
      address: {
        line1: d?.line1 ?? null,
        line2: d?.line2 ?? null,
        city: d?.city ?? null,
        state: d?.state ?? null,
        zip: d?.zip ?? null,
      },
    };
  });

  const batch = assembleForm1099Batch(payer, recipients, year);

  // 5. Transmitter identity — defaults to the payer; TCC from env unless overridden.
  const transmitter: FireTransmitter = {
    tcc: param(sp, 'tcc') ?? process.env.IRS_FIRE_TCC ?? null,
    tin: param(sp, 'transmitterTin') ?? payer.tin,
    name: param(sp, 'transmitterName') ?? payer.name,
    companyName: param(sp, 'transmitterName') ?? payer.name,
    addressLine1: payer.addressLine1,
    city: payer.city,
    state: payer.state,
    zip: payer.zip,
    contactName: param(sp, 'contactName'),
    contactPhone: param(sp, 'contactPhone') ?? payer.phone,
    contactEmail: param(sp, 'contactEmail'),
    testFile: sp.get('test') === '1' || sp.get('test') === 'true',
  };

  const fire = buildFireFile(batch, { taxYear: year, transmitter });
  const slug = slugify(payer.name);

  // ── FIRE fixed-width e-file ─────────────────────────────────────────────────────
  if (format === 'fire' || format === 'txt') {
    if (batch.records.length === 0) {
      return NextResponse.json(
        { error: 'No filable 1099-NEC records — resolve blockers or confirm candidates first.', code: 'NO_RECORDS' },
        { status: 422 },
      );
    }
    return new NextResponse(fire.content, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=ascii',
        'Content-Disposition': `attachment; filename="1099-nec-fire-${slug}-${year}.txt"`,
        'Cache-Control': 'private, no-store',
        // Non-secret operator hint that config gaps exist (full text is in the summary).
        'X-Fire-Has-Placeholders': String(fire.hasPlaceholders),
      },
    });
  }

  // ── Summary (default) — the pre-download review; never ships full TINs ───────────
  const blockers = batch.exclusions
    .filter((e) => e.status === 'BLOCKED')
    .map((e) => ({ vendorId: e.vendorId, vendorName: e.vendorName, totalPaidCents: e.totalPaidCents, code: e.code, reason: e.reason }));

  return NextResponse.json({
    data: {
      taxYear: year,
      readyCount: batch.records.length,
      totalNonemployeeCompCents: batch.summary.totalNonemployeeCompCents,
      blockedCount: batch.summary.blockedCount,
      blockedDollarsCents: batch.summary.blockedDollarsCents,
      payerTinMissing: batch.summary.payerTinMissing,
      // FIRE-specific config readiness.
      hasPlaceholders: fire.hasPlaceholders,
      warnings: fire.warnings,
      recordCount: fire.recordCount,
      payeeCount: fire.payeeCount,
      blockers,
      transmitted: false,
    },
  });
}
