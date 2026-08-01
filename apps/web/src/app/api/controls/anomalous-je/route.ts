export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { scanAnomalousJournalEntries } from '@/lib/controls/anomalous-je';

/**
 * EC-10 — Anomalous / unsupported journal-entry control (AU-C 240).
 *
 * POST to run a scan of the tenant's posted manual JE population. Flagged entries
 * are written as PROPOSED `ai_decisions` (feature ANOMALOUS_JE), which the
 * existing /exceptions queue already ingests — no aggregator change needed. The
 * scan is idempotent per gl_entry, so this is safe to run on a cadence or on
 * demand. RLS-scoped: the org UUID comes from the token claim and every query
 * runs as the user, so the database enforces tenant isolation.
 */

const bodySchema = z.object({
  since_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().positive().max(5000).optional(),
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

  const result = await scanAnomalousJournalEntries(supabase, orgId, {
    sinceDate: parsed.data.since_date,
    limit: parsed.data.limit,
  });

  return NextResponse.json(result);
}
