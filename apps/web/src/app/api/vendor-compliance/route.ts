export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import {
  getVendorComplianceOverview,
  grantOverride,
  releaseOverride,
  runComplianceMaintenance,
} from '@/lib/services/vendor-compliance';
import { getTierPolicy } from '@/lib/trust/score-tier';
import { assessVendorRisk } from '@/lib/compliance/risk';
import { assessAndEscalate } from '@/lib/compliance/assess';

type DocState = 'valid' | 'expiring' | 'expired' | 'missing' | 'pending';

const EMPTY_DOC_COUNTS = { valid: 0, expiring: 0, expired: 0, missing: 0, pending: 0 };

// ─── GET: vendor-compliance overview (decorated with AI risk tiers) ───────────
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({
      rows: [],
      summary: {
        total: 0, onHold: 0, withOverride: 0, compliant: 0, blockedBalanceCents: 0,
        atRisk: 0, escalations: 0, docCounts: EMPTY_DOC_COUNTS,
      },
    });
  }

  const [overview, policy] = await Promise.all([
    getVendorComplianceOverview(supabase, orgId),
    getTierPolicy(supabase, orgId),
  ]);

  const docCounts = { ...EMPTY_DOC_COUNTS };
  let escalations = 0;
  let atRisk = 0;

  const rows = overview.rows.map((r) => {
    for (const d of r.docs) docCounts[d.state as DocState] = (docCounts[d.state as DocState] ?? 0) + 1;
    const risk = assessVendorRisk(
      {
        docs: r.docs.map((d) => ({ doc_type: d.doc_type, state: d.state })),
        onHold: r.onHold,
        hasActiveOverride: !!r.activeOverride,
        openBillsCents: r.openBillsCents,
      },
      policy,
    );
    if (risk.tier === 'escalate' && r.onHold) escalations += 1;
    if (!r.compliant) atRisk += 1;
    return { ...r, risk };
  });

  // Most urgent first (highest risk score), exposure as tiebreak.
  rows.sort((a, b) => b.risk.score - a.risk.score || b.openBillsCents - a.openBillsCents);

  return NextResponse.json({
    rows,
    summary: { ...overview.summary, atRisk, escalations, docCounts },
  });
}

// ─── POST: override grant / release / maintenance run ─────────────────────────
const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('grant_override'),
    vendor_id: z.string().uuid(),
    hold_type: z.enum(['ONE_TIME', 'TEMPORARY', 'PERMANENT']),
    reason: z.string().min(3).max(1000),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  z.object({
    action: z.literal('release_override'),
    override_id: z.string().uuid(),
    reason: z.string().min(3).max(1000),
  }),
  z.object({ action: z.literal('run_maintenance') }),
]);

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path.join('.') || '_root';
      (details[k] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', details }, { status: 422 });
  }

  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const body = parsed.data;

  if (body.action === 'grant_override') {
    const res = await grantOverride(supabase, orgId, {
      vendorId: body.vendor_id,
      holdType: body.hold_type,
      reason: body.reason,
      endDate: body.end_date ?? null,
      actor: userId,
    });
    if (!res.success) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ override_id: res.overrideId }, { status: 201 });
  }

  if (body.action === 'release_override') {
    const res = await releaseOverride(supabase, orgId, body.override_id, body.reason, userId);
    if (!res.success) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  // run_maintenance: auto-expire + advance chase cadence, THEN run the AI risk
  // assessment (logs to the trust audit trail) and escalate on-hold/high-risk
  // vendors into the /exceptions queue.
  const res = await runComplianceMaintenance(supabase, orgId);
  const assessment = await assessAndEscalate(supabase, orgId);
  return NextResponse.json({
    expired: res.expired,
    chased: res.chased,
    assessed: assessment.assessed,
    escalated: assessment.escalated,
    queued: assessment.queued,
  });
}
