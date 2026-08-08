export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { renderToBuffer } from '@react-pdf/renderer';
import { CompilePackPdf } from '../../compile/compile-pack-pdf';
import { runPack } from '@/lib/reports/compiler/run';
import {
  resolveSavedPack,
  parseStoredSpecs,
  nextOccurrence,
  cadenceLabel,
  type Cadence,
} from '@/lib/reports/compiler/packs';
import { buildPackEmail } from '@/lib/reports/compiler/pack-email';
import { buildExportFilename } from '@/lib/reports/export/statement-model';
import { createOrgScopedSupabase } from '@/lib/reports/compiler/org-scoped-client';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveEmailProvider, resolveFromAddress, EmailSendError } from '@/lib/email/provider';

/**
 * POST /api/reports/packs/run-scheduled — the SERVER-TO-SERVER delivery worker.
 *
 * A trusted external scheduler (e.g. a daily Vercel Cron or the ops box's crontab)
 * calls this once a day with the shared secret in `x-report-pack-secret`. It finds
 * every ACTIVE saved pack whose next_run_date is due, re-resolves its descriptors
 * to today's fiscal dates, renders the combined PDF, and emails it to the pack's
 * recipients via the existing Resend path. Then it advances next_run_date so each
 * pack fires once per period.
 *
 * SECURITY / ISOLATION
 * - Auth is SECRET-ONLY (constant-time compare) and FAILS CLOSED: if
 *   REPORT_PACK_CRON_SECRET is unset, the endpoint is disabled. No Clerk session
 *   can trigger it (this fans out across tenants; an ordinary user must not).
 * - Pack DISCOVERY uses the admin client (metadata only — names, cadences,
 *   recipients). But every LEDGER read runs through a per-org RLS-scoped client
 *   (createOrgScopedSupabase), so the report engines can only ever see the pack's
 *   own tenant. If that scoped client can't be minted (JWT secret missing) the
 *   pack is skipped as undeliverable — the RLS-bypassing admin client NEVER
 *   touches ledger data.
 * - HUMAN GATE: only packs the user explicitly scheduled (active + cadence +
 *   recipients) are ever delivered. Nothing auto-emails by default.
 */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function authorize(req: Request): boolean {
  const secret = process.env.REPORT_PACK_CRON_SECRET;
  const presented = req.headers.get('x-report-pack-secret');
  return Boolean(secret && secret.length > 0 && presented && safeEqual(presented, secret));
}

interface DuePackRow {
  id: string;
  org_id: string;
  name: string;
  entity_label: string | null;
  location_ids: string[] | null;
  specs: unknown;
  schedule_cadence: Cadence;
  recipients: string[] | null;
}

interface PackResult {
  id: string;
  name: string;
  status: 'DELIVERED' | 'FAILED' | 'SKIPPED';
  detail?: string;
  recipients?: number;
}

async function fyStartMonthFor(supabase: ReturnType<typeof createAdminSupabase>, orgId: string): Promise<number> {
  try {
    const { data } = await supabase.from('organizations').select('fiscal_year_start_month').eq('id', orgId).maybeSingle();
    const m = Number((data as { fiscal_year_start_month?: number } | null)?.fiscal_year_start_month ?? 1);
    if (Number.isInteger(m) && m >= 1 && m <= 12) return m;
  } catch {
    /* default calendar year */
  }
  return 1;
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const admin = createAdminSupabase();
  const today = new Date().toISOString().slice(0, 10);

  // Discover due packs (metadata only). Admin client — no ledger data touched here.
  const { data: due, error } = await admin
    .from('report_packs')
    .select('id, org_id, name, entity_label, location_ids, specs, schedule_cadence, recipients')
    .eq('schedule_active', true)
    .neq('schedule_cadence', 'NONE')
    .lte('next_run_date', today);

  if (error) {
    if (error.code === '42P01' || /relation .* does not exist/i.test(error.message ?? '')) {
      return NextResponse.json({ available: false, processed: 0, results: [] });
    }
    return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  }

  const packs = (due ?? []) as DuePackRow[];
  const provider = resolveEmailProvider();
  const from = resolveFromAddress();
  const results: PackResult[] = [];

  for (const pack of packs) {
    const recipients = (pack.recipients ?? []).filter(Boolean);
    // Advance next_run_date regardless of outcome so a failure never retry-storms.
    const advance = nextOccurrence(pack.schedule_cadence, today);

    const record = async (status: string) => {
      await admin
        .from('report_packs')
        .update({ last_run_at: new Date().toISOString(), last_run_status: status.slice(0, 200), next_run_date: advance })
        .eq('id', pack.id);
    };

    if (recipients.length === 0) {
      results.push({ id: pack.id, name: pack.name, status: 'SKIPPED', detail: 'no recipients' });
      await record('SKIPPED: no recipients');
      continue;
    }
    if (!provider || !from) {
      results.push({ id: pack.id, name: pack.name, status: 'SKIPPED', detail: 'email not configured' });
      await record('SKIPPED: email not configured');
      continue;
    }

    const specs = parseStoredSpecs(pack.specs);
    if (!specs) {
      results.push({ id: pack.id, name: pack.name, status: 'FAILED', detail: 'stored spec no longer valid' });
      await record('FAILED: stored spec no longer valid');
      continue;
    }

    // Per-org RLS-scoped client — the ONLY client that reads ledger data.
    const scoped = createOrgScopedSupabase(pack.org_id);
    if (!scoped) {
      results.push({ id: pack.id, name: pack.name, status: 'SKIPPED', detail: 'tenant-scoped access unavailable (SUPABASE_JWT_SECRET missing)' });
      await record('SKIPPED: tenant isolation unavailable');
      continue;
    }

    try {
      const fyStartMonth = await fyStartMonthFor(admin, pack.org_id);
      const resolved = resolveSavedPack(specs, pack.entity_label, pack.location_ids, fyStartMonth);
      const compiled = await runPack(scoped, pack.org_id, resolved);
      if (compiled.sections.length === 0) {
        results.push({ id: pack.id, name: pack.name, status: 'FAILED', detail: 'resolved to no sections' });
        await record('FAILED: no sections');
        continue;
      }

      const pdf = await renderToBuffer(<CompilePackPdf pack={compiled} />);
      const filename = buildExportFilename(`report-pack-${pack.name}`, 'pdf');
      const { subject, html, text } = buildPackEmail(compiled, pack.name, cadenceLabel(pack.schedule_cadence));

      await provider.send(
        {
          to: recipients,
          subject,
          html,
          text,
          attachments: [{ filename, content: new Uint8Array(pdf), contentType: 'application/pdf' }],
        },
        from,
      );

      results.push({ id: pack.id, name: pack.name, status: 'DELIVERED', recipients: recipients.length });
      await record(`DELIVERED to ${recipients.length} recipient(s)`);
    } catch (e) {
      const detail = e instanceof EmailSendError ? e.message : e instanceof Error ? e.message : 'unknown error';
      console.error('[report-pack cron] delivery failed', pack.id, detail);
      results.push({ id: pack.id, name: pack.name, status: 'FAILED', detail });
      await record(`FAILED: ${detail}`);
    }
  }

  const delivered = results.filter((r) => r.status === 'DELIVERED').length;
  const failed = results.filter((r) => r.status === 'FAILED').length;
  return NextResponse.json({ available: true, processed: packs.length, delivered, failed, results });
}
