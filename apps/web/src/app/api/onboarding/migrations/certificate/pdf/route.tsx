export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { requireAuthedContext } from '@/lib/api-handler';
import { migrationErrorResponse } from '@/lib/onboarding/migration/server/guard';
import { withProject } from '@/lib/onboarding/migration/server/route-support';
import { loadCertificate } from '@/lib/onboarding/migration/server/certificate';
import { loadPeople } from '@/lib/onboarding/migration/server/store';
import { ConversionCertificatePdf, type CertificatePdfModel } from '@/lib/onboarding/migration/certificate-pdf';
import { HISTORY_DEPTH_COPY, SHADOW_MODE_COPY } from '@/lib/onboarding/migration/stages';
import type { HistoryDepth } from '@/lib/onboarding/migration/types';

/** GET /api/onboarding/migrations/certificate/pdf?id=<project> — the certificate as a PDF (journal_entries:view + client scope). */
export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Missing id', code: 'BAD_REQUEST' }, { status: 400 });
  const pc = await withProject(ctx, id, 'view', '/api/onboarding/migrations/certificate/pdf');
  if (pc instanceof NextResponse) return pc;
  try {
    const cert = await loadCertificate(pc.supabase, pc.project);
    if (!cert) return NextResponse.json({ error: 'No certificate yet — the preparer signs the balance proof first.', code: 'NO_CERT' }, { status: 404 });
    const [{ data: loc }, { data: org }, people] = await Promise.all([
      pc.supabase.schema('core').from('locations').select('name, short_code').eq('id', pc.project.location_id).maybeSingle(),
      pc.supabase.schema('core').from('organizations').select('name').eq('id', pc.orgId).maybeSingle(),
      loadPeople(pc.supabase, pc.orgId),
    ]);
    const nameOf = (u: string | null) => (u ? people.find((p) => p.userId === u)?.name ?? 'Team member' : null);
    const ms = cert.mappingSummary as { accounts?: number; accepted?: number; typeExceptions?: Array<{ account: string; reason: string | null }> };
    const disp = (cert.preflightDispositions as Array<{ name: string; severity: string; amount_cents: number; disposition: string; disposition_note: string | null }>).filter((d) => d.severity !== 'info' || d.disposition !== 'open');
    const shadowSkipped = (pc.project.skipped_stages ?? []).includes('shadow_close');
    const model: CertificatePdfModel = {
      number: cert.number,
      version: cert.version,
      status: cert.status,
      clientName: (loc as { name: string } | null)?.name ?? 'Client',
      clientCode: (loc as { short_code: string } | null)?.short_code ?? '',
      tenantName: (org as { name: string } | null)?.name ?? '',
      cutoverDate: cert.cutoverDate,
      historyDepthLabel: HISTORY_DEPTH_COPY[cert.historyDepth as HistoryDepth]?.label ?? cert.historyDepth,
      preparedBy: nameOf(cert.preparedBy) ?? 'Preparer',
      preparedAt: cert.preparedAt,
      approvedBy: nameOf(cert.approvedBy),
      approvedAt: cert.approvedAt,
      voidReason: cert.voidReason,
      contentHash: cert.contentHash,
      ties: cert.ties,
      sources: (cert.sources as CertificatePdfModel['sources']) ?? [],
      dispositions: disp.map((d) => ({ name: d.name, severity: d.severity, amountCents: Number(d.amount_cents ?? 0), disposition: d.disposition, note: d.disposition_note })),
      mapping: { accounts: ms.accounts ?? 0, accepted: ms.accepted ?? 0, typeExceptions: ms.typeExceptions ?? [] },
      practiceClose: shadowSkipped ? 'Skipped with a reason (see the trail)' : SHADOW_MODE_COPY[pc.project.shadow_mode].label,
    };
    const buffer = await renderToBuffer(<ConversionCertificatePdf m={model} />);
    const filename = `${cert.number}-${model.clientCode || 'client'}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
    return new NextResponse(new Uint8Array(buffer) as unknown as BodyInit, {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not build the certificate PDF');
  }
}
