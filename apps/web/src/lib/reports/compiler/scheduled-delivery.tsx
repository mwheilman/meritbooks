/**
 * Scheduled report-pack delivery — the engine behind both the legacy
 * server-to-server route (POST /api/reports/packs/run-scheduled, all tenants) and
 * the M-12 scheduler job `reports.packs` (one tenant per run).
 *
 * Finds every ACTIVE saved pack whose next_run_date is due, re-resolves its
 * descriptors to today's fiscal dates, renders the combined PDF, emails it to the
 * pack's recipients, then advances next_run_date so each pack fires once per period.
 *
 * SECURITY / ISOLATION (unchanged from the original route)
 * - Pack DISCOVERY uses the admin client (metadata only — names, cadences,
 *   recipients). Every LEDGER read runs through a per-org RLS-scoped client
 *   (createOrgScopedSupabase), so the report engines only ever see the pack's own
 *   tenant. If that client can't be minted the pack is SKIPPED — the RLS-bypassing
 *   admin client never touches ledger data.
 * - HUMAN GATE: only packs a user explicitly scheduled (active + cadence +
 *   recipients) are delivered. Nothing auto-emails by default.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { renderToBuffer } from '@react-pdf/renderer';
import { CompilePackPdf } from '@/app/api/reports/compile/compile-pack-pdf';
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
import { resolveEmailProvider, resolveFromAddress, EmailSendError } from '@/lib/email/provider';

interface DuePackRow {
  id: string;
  org_id: string;
  name: string;
  entity_label: string | null;
  location_ids: string[] | null;
  specs: unknown;
  schedule_cadence: Cadence;
  recipients: string[] | null;
  next_run_date: string | null;
}

export interface PackResult {
  id: string;
  name: string;
  status: 'DELIVERED' | 'FAILED' | 'SKIPPED';
  detail?: string;
  recipients?: number;
}

export type DeliverDuePacksResult =
  | { ok: true; available: boolean; processed: number; delivered: number; failed: number; skipped: number; results: PackResult[] }
  | { ok: false; error: string };

async function fyStartMonthFor(admin: SupabaseClient, orgId: string): Promise<number> {
  try {
    const { data } = await admin.from('organizations').select('fiscal_year_start_month').eq('id', orgId).maybeSingle();
    const m = Number((data as { fiscal_year_start_month?: number } | null)?.fiscal_year_start_month ?? 1);
    if (Number.isInteger(m) && m >= 1 && m <= 12) return m;
  } catch {
    /* default calendar year */
  }
  return 1;
}

/**
 * Deliver every due pack. `orgId` restricts discovery to one tenant (the scheduler
 * job); null/undefined = every tenant (the legacy secret-gated route).
 */
export async function deliverDuePacks(
  admin: SupabaseClient,
  opts: { orgId?: string | null; today?: string; signal?: AbortSignal } = {},
): Promise<DeliverDuePacksResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  let query = admin
    .from('report_packs')
    .select('id, org_id, name, entity_label, location_ids, specs, schedule_cadence, recipients, next_run_date')
    .eq('schedule_active', true)
    .neq('schedule_cadence', 'NONE')
    .lte('next_run_date', today);
  if (opts.orgId) query = query.eq('org_id', opts.orgId);
  const { data: due, error } = await query;

  if (error) {
    if (error.code === '42P01' || /relation .* does not exist/i.test(error.message ?? '')) {
      return { ok: true, available: false, processed: 0, delivered: 0, failed: 0, skipped: 0, results: [] };
    }
    return { ok: false, error: error.message };
  }

  const packs = (due ?? []) as DuePackRow[];
  const provider = resolveEmailProvider();
  const from = resolveFromAddress();
  const results: PackResult[] = [];

  for (const pack of packs) {
    if (opts.signal?.aborted) break; // remaining packs stay due for the next run
    const recipients = (pack.recipients ?? []).filter(Boolean);
    // Advance next_run_date regardless of outcome so a failure never retry-storms.
    const advance = nextOccurrence(pack.schedule_cadence, today);

    // Claim the occurrence atomically BEFORE doing any work: advance next_run_date
    // only if it still holds the value we read. If two workers (the scheduler job
    // and the legacy ops route) race on the same pack, exactly one wins the claim
    // and the other skips — so a pack is never emailed twice for one occurrence.
    let claim = admin.from('report_packs').update({ next_run_date: advance }).eq('id', pack.id);
    claim = pack.next_run_date === null ? claim.is('next_run_date', null) : claim.eq('next_run_date', pack.next_run_date);
    const { data: claimed, error: claimErr } = await claim.select('id');
    if (claimErr || !claimed || (claimed as unknown[]).length === 0) {
      results.push({ id: pack.id, name: pack.name, status: 'SKIPPED', detail: 'already claimed by another run' });
      continue;
    }

    const record = async (status: string) => {
      await admin
        .from('report_packs')
        .update({ last_run_at: new Date().toISOString(), last_run_status: status.slice(0, 200) })
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
      console.error('[report-pack delivery] failed', pack.id, detail);
      results.push({ id: pack.id, name: pack.name, status: 'FAILED', detail });
      await record(`FAILED: ${detail}`);
    }
  }

  return {
    ok: true,
    available: true,
    processed: results.length,
    delivered: results.filter((r) => r.status === 'DELIVERED').length,
    failed: results.filter((r) => r.status === 'FAILED').length,
    skipped: results.filter((r) => r.status === 'SKIPPED').length,
    results,
  };
}
