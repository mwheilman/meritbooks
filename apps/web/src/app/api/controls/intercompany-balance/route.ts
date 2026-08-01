export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { scanIntercompanyBalance } from '@/lib/controls/intercompany-balance';

/**
 * EC-3 — Intercompany / interdepartmental out-of-balance control.
 *
 * POST /api/controls/intercompany-balance
 *   Runs the three balance assertions for the caller's org and returns a summary
 *   of what was scanned and how many NEW exceptions were queued into /exceptions
 *   (as PROPOSED `ai_decisions`, feature 'INTERCOMPANY_IMBALANCE'):
 *     (a) interdept eliminating revenue == cost, per company/period
 *     (b) intercompany due-from == due-to (AR nets AP), per period
 *     (c) internal invoices booked on one side but not the other
 *   Idempotent — a second call queues nothing new because each hit carries a
 *   stable dedup_key (company + period + kind).
 *
 * RLS-scoped: the org UUID comes from the token claim and every query runs as the
 * user, so the database enforces tenant isolation; the route never filters org_id
 * by hand. This detects and DRAFTS remediations only — it never posts a mirror
 * entry, books a correction, or edits the ledger (canon §3: AI proposes; a human
 * with the right role acts).
 */

const bodySchema = z.object({
  since_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  // Body is optional; tolerate an empty request.
  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path.join('.') || '_root';
      (details[k] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details }, { status: 422 });
  }

  const summary = await scanIntercompanyBalance(supabase, orgId, {
    sinceDate: parsed.data.since_date,
  });

  return NextResponse.json({ data: summary });
}
