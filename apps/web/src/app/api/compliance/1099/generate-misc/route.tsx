export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { buildReadinessReport } from '../readiness';
import { slugify, type PayerInfo } from '@/lib/tax/form-1099';
import {
  assembleForm1099MiscBatch,
  toMiscImportCsv,
  miscBoxAmount,
  MISC_BOX_CODES,
  type RecipientMiscInput,
  type MiscBoxCents,
  type MiscBoxCode,
} from '@/lib/tax/form-1099-misc';
import { Form1099MiscPdf } from '@/lib/tax/form-1099-misc-pdf';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * 1099-MISC GENERATION — the MISC sibling of ../generate (which does NEC). Read-only
 * assembly of the filing-service e-file + recipient Copy B PDFs + summary off the
 * owned ledger (canon §3: automation proposes; a human reviews and transmits). NO IRS
 * transmit here, NO ledger write, NO money movement — this endpoint only reads and
 * renders. The IRS FIRE fixed-width file for MISC is ../../../tax/1099/efile-misc.
 *
 * GET /api/compliance/1099/generate-misc?year=YYYY&format=summary|csv|pdf
 *   &payerTin=&payerName=&payerAddress1=&payerAddress2=&payerCity=&payerState=&payerZip=&payerPhone=
 *
 *   summary (default) — JSON { payer(masked TIN), summary, records(masked, per-box), exclusions }.
 *   csv     — filing-service import e-file (attachment). READY records only.
 *   pdf     — branded recipient Copy B copies, one page per READY recipient.
 *
 * RLS-scoped: the DB enforces org isolation; this route never filters org_id by hand.
 */

const CURRENT_YEAR = new Date().getFullYear();

function param(sp: URLSearchParams, key: string): string | null {
  const v = sp.get(key);
  return v && v.trim().length > 0 ? v.trim() : null;
}

/** Split a multiline remit-to block into up-to address1 / address2 / city-state-zip. */
function parseRemitTo(remit: string | null): {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const empty = { line1: null, line2: null, city: null, state: null, zip: null };
  if (!remit) return empty;
  const lines = remit
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return empty;
  const last = lines[lines.length - 1];
  const m = last.match(/^(.+?),?\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (m && lines.length >= 1) {
    return {
      line1: lines[0] ?? null,
      line2: lines.length > 2 ? lines[1] : null,
      city: m[1].replace(/,$/, '').trim(),
      state: m[2].toUpperCase(),
      zip: m[3],
    };
  }
  return { line1: lines[0] ?? null, line2: lines[1] ?? null, city: null, state: null, zip: null };
}

/** Pull the MISC-classified box split (cents) out of a readiness row's boxes. */
function miscBoxCentsFromRow(boxes: Array<{ code: string; form: string; cents: number }>): MiscBoxCents {
  const out: MiscBoxCents = {};
  for (const b of boxes) {
    if (b.form === 'MISC' && (MISC_BOX_CODES as string[]).includes(b.code)) {
      out[b.code as MiscBoxCode] = (out[b.code as MiscBoxCode] ?? 0) + (Number(b.cents) || 0);
    }
  }
  return out;
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

  // 1. Readiness = candidate list + per-vendor reportable (non-card) totals + box split.
  const readiness = await buildReadinessReport(supabase, year);
  const vendorIds = readiness.rows.map((r) => r.vendorId);

  // 2. Recipient address + TIN for the candidates (RLS-scoped core.vendors).
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
      .select('remit_to, logo_url, accent_color')
      .eq('org_id', orgId)
      .limit(1)
      .maybeSingle(),
  ]);
  const orgName = (org as { name?: string } | null)?.name ?? 'Payer';
  const tpl = (tmpl as { remit_to?: string; logo_url?: string; accent_color?: string } | null) ?? null;
  const remit = parseRemitTo(tpl?.remit_to ?? null);

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

  // 4. Assemble MISC recipient inputs and the batch.
  const recipients: RecipientMiscInput[] = readiness.rows.map((r) => {
    const d = vendorDetail.get(r.vendorId);
    return {
      vendorId: r.vendorId,
      vendorName: r.vendorName,
      totalPaidCents: r.totalPaidCents,
      paymentCount: r.paymentCount,
      is1099Eligible: r.is1099Eligible,
      w9Status: r.w9Status,
      // The MISC boxes are the rents / royalties / medical / attorney / other-income
      // dollars classified from the GL expense coding — NEC (services) is filed separately.
      miscBoxCents: miscBoxCentsFromRow(r.boxes),
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

  const batch = assembleForm1099MiscBatch(payer, recipients, year);
  const slug = slugify(payer.name);

  // ── CSV e-file ────────────────────────────────────────────────────────────────
  if (format === 'csv') {
    if (batch.records.length === 0) {
      return NextResponse.json(
        { error: 'No filable 1099-MISC records — resolve blockers or confirm candidates first.', code: 'NO_RECORDS' },
        { status: 422 },
      );
    }
    const csv = toMiscImportCsv(batch);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="1099-misc-${slug}-${year}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  // ── Recipient Copy B PDFs ───────────────────────────────────────────────────────
  if (format === 'pdf') {
    if (batch.records.length === 0) {
      return NextResponse.json(
        { error: 'No recipient copies to render — no 1099-MISC records are ready.', code: 'NO_RECORDS' },
        { status: 422 },
      );
    }
    const buffer = await renderToBuffer(
      <Form1099MiscPdf batch={batch} accentColor={tpl?.accent_color ?? null} logoUrl={tpl?.logo_url ?? null} />,
    );
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="1099-misc-copyb-${slug}-${year}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  // ── Summary (default) — masks TINs; never ships full TINs to the browser ────────
  return NextResponse.json({
    data: {
      payer: {
        name: payer.name,
        tinMasked: payer.tin ? `**-***${(payer.tin.replace(/\D/g, '')).slice(-4)}` : null,
        addressLine1: payer.addressLine1,
        addressLine2: payer.addressLine2,
        city: payer.city,
        state: payer.state,
        zip: payer.zip,
        phone: payer.phone,
      },
      summary: batch.summary,
      records: batch.records.map((r) => ({
        vendorId: r.vendorId,
        recipientName: r.recipientName,
        recipientTinMasked: r.recipientTinMasked,
        boxAmounts: Object.fromEntries(
          MISC_BOX_CODES.map((code) => [code, miscBoxAmount(r.boxAmounts, code)]).filter(([, c]) => (c as number) > 0),
        ),
        box4FederalTaxWithheldCents: r.box4FederalTaxWithheldCents,
        totalReportableMiscCents: r.totalReportableMiscCents,
        hasAddress: !!(r.address.line1 && r.address.city && r.address.state && r.address.zip),
      })),
      exclusions: batch.exclusions,
    },
  });
}
