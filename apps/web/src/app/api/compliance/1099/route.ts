export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler, apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { formatMoney } from '@meritbooks/shared';
import { buildReadinessReport } from './readiness';

/**
 * 1099-NEC readiness surface (CPA panel) — docs/discovery/books/cpa-tax-assurance.md §B4.
 *
 * GET  /api/compliance/1099?year=YYYY
 *   Returns every vendor paid >= $600 by a REPORTABLE (non-card) rail in the tax
 *   year, with its W-9 / TIN / 1099-eligibility status and a readiness flag, plus
 *   summary tiles. Read-only. RLS-scoped — the DB enforces org isolation.
 *
 * POST /api/compliance/1099   { vendorId, year? }
 *   "Flag missing W-9" — queues a compliance chase for a candidate with a gap.
 *   Reuses the vendor-compliance escalation rail: writes a PROPOSED ai_decisions
 *   row (→ surfaces in /exceptions) AND schedules a W-9 chase on the vendor-
 *   compliance-docs engine (runComplianceMaintenance picks it up). Idempotent per
 *   (vendor, year). Detect/queue only — it never files a form or moves money
 *   (canon §3: AI proposes facts; a human acts).
 */

const CURRENT_YEAR = new Date().getFullYear();

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }
  // Gate on Compliance:view (closest to vendor_compliance in the RBAC catalog).
  const guard = await requirePermission(ctx.userId, 'compliance', 'view');
  if (!guard.ok) return guard.response;

  const year = params.year ?? CURRENT_YEAR;
  const report = await buildReadinessReport(ctx.supabase, year);
  return NextResponse.json({ data: report });
});

// ── Flag-gap action ─────────────────────────────────────────────────────────────

export const FLAG_FEATURE = 'W9_1099_GAP';

const flagSchema = z.object({
  vendorId: z.string().uuid(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const POST = apiHandler(flagSchema, async (body, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }
  // Queuing a chase is a write/escalation → Compliance:manage.
  const guard = await requirePermission(ctx.userId, 'compliance', 'manage');
  if (!guard.ok) return guard.response;

  const { supabase, orgId, userId } = ctx;
  const year = body.year ?? CURRENT_YEAR;
  const dedupKey = `1099_w9:${year}:${body.vendorId}`;

  // Recompute against the same source of truth so the flag can't be forged from a
  // stale client — the vendor must be a real candidate WITH a gap this year.
  const report = await buildReadinessReport(supabase, year);
  const row = report.rows.find((r) => r.vendorId === body.vendorId);
  if (!row) {
    return NextResponse.json(
      { error: `Vendor is not a ${year} 1099 candidate (no reportable payments >= $600).`, code: 'NOT_A_CANDIDATE' },
      { status: 400 },
    );
  }
  if (row.readiness === 'READY') {
    return NextResponse.json(
      { error: 'Vendor is already 1099-ready — nothing to chase.', code: 'ALREADY_READY' },
      { status: 400 },
    );
  }

  // Idempotency: don't double-queue the same (vendor, year) gap.
  const { data: existing } = await supabase
    .from('ai_decisions')
    .select('id, proposed_output')
    .eq('feature', FLAG_FEATURE)
    .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
  const already = (existing ?? []).find(
    (d) => (d as { proposed_output?: { dedup_key?: string } }).proposed_output?.dedup_key === dedupKey,
  );
  if (already) {
    return NextResponse.json({ data: { queued: false, alreadyQueued: true, decisionId: (already as { id: string }).id } });
  }

  const gapLabel = row.readiness === 'NOT_MARKED_1099' ? 'not marked 1099-eligible' : 'W-9 / TIN missing';
  const title = `1099 gap: ${row.vendorName} · ${formatMoney(row.totalPaidCents)} paid in ${year} · ${gapLabel}`;
  const reason =
    `${row.vendorName} was paid ${formatMoney(row.totalPaidCents)} by reportable (non-card) rails in ${year} ` +
    `(${row.paymentCount} payment${row.paymentCount === 1 ? '' : 's'}), crossing the $600 1099-NEC floor, but ` +
    (row.readiness === 'NOT_MARKED_1099'
      ? 'the vendor is not flagged 1099-eligible. Confirm entity type (a corporation is exempt) or mark it eligible and collect a W-9.'
      : `the W-9 is ${row.w9Status.replace('_', ' ')}${row.tinPresent ? '' : ' and no TIN is on file'}. Collect the W-9 before filing to avoid backup withholding / penalties.`);

  const { data: inserted, error: insErr } = await supabase
    .from('ai_decisions')
    .insert({
      org_id: orgId,
      feature: FLAG_FEATURE,
      input_summary: title,
      proposed_output: {
        control: 'B4',
        dedup_key: dedupKey,
        tax_year: year,
        vendor_id: row.vendorId,
        readiness: row.readiness,
        w9_status: row.w9Status,
        tin_present: row.tinPresent,
        amount_at_risk_cents: row.totalPaidCents,
        subjects: { vendor_id: row.vendorId },
      },
      confidence: 0.95,
      reasoning: reason,
      clarifying_question: 'Send the W-9 request now, or confirm this vendor is 1099-exempt?',
      status: 'PROPOSED',
      created_by_user: userId,
    })
    .select('id')
    .single();
  if (insErr) {
    return NextResponse.json(
      { error: `Could not queue exception: ${insErr.message}`, code: 'QUEUE_FAILED' },
      { status: 500 },
    );
  }

  // Schedule a W-9 chase on the vendor-compliance engine so runComplianceMaintenance
  // advances the cadence. Best-effort — never fail the flag on the audit-side write.
  try {
    const { data: doc } = await supabase
      .from('vendor_compliance_docs')
      .select('id')
      .eq('vendor_id', row.vendorId)
      .eq('doc_type', 'W9')
      .limit(1)
      .maybeSingle();
    const nowIso = new Date().toISOString();
    if (doc?.id) {
      await supabase
        .from('vendor_compliance_docs')
        .update({ next_chase_at: nowIso, updated_at: nowIso })
        .eq('id', (doc as { id: string }).id);
    } else {
      await supabase.from('vendor_compliance_docs').insert({
        org_id: orgId,
        vendor_id: row.vendorId,
        doc_type: 'W9',
        status: 'MISSING',
        next_chase_at: nowIso,
      });
    }
  } catch (e) {
    console.warn('[1099] W-9 chase schedule skipped:', e instanceof Error ? e.message : e);
  }

  await logHumanAction(supabase, userId, orgId, {
    action: 'compliance.1099.flag_w9_gap',
    subjectTable: 'vendors',
    subjectId: row.vendorId,
    summary: title,
    metadata: { tax_year: year, dedup_key: dedupKey, amount_at_risk_cents: row.totalPaidCents, readiness: row.readiness },
  });

  return NextResponse.json({ data: { queued: true, alreadyQueued: false, decisionId: (inserted as { id: string }).id } });
});
