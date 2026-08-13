export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { autoMap } from '@/lib/import/csv';
import {
  WIP_IMPORT_FIELDS,
  normalizeWipCsvRows,
  computeOpeningWip,
  wipImportBlockers,
  parseWipDocument,
  createOpeningJobs,
  attachWipSubledgerDetail,
  type ProposedJob,
} from '@/lib/onboarding/wip-import';

/**
 * POST /api/onboarding/import/wip — the jobs/WIP onboarding importer.
 *
 * Modes (degrade-safe: the CSV path is fully functional with AI OFF):
 *   • { mode:'parse', source:'csv', rows, mapping?, headers? }
 *       → deterministic column-map import (alias auto-detect) → ProposedJob[] + the
 *         opening WIP schedule preview (earned/over/under) + the tie-out totals.
 *   • { mode:'parse', source:'document', base64Data, mediaType }
 *       → drop-and-parse a WIP schedule / contracts PDF via the AI gateway
 *         (WIP_EXTRACT). Falls back to CSV when the key/budget is unavailable.
 *   • { mode:'commit', companyId, jobs, sessionId?, asOfDate? }
 *       → create the open jobs in core.jobs and stage the opening WIP totals into the
 *         conversion session's subledgerDetail so the extended tie-out fires
 *         (Σ costs = WIP, Σ unbilled = 1180, Σ billings-in-excess = 2410).
 *
 * NEVER posts a recognition entry — onboarding sets the OPENING POSITION only.
 */

const MAX_ROWS = 20000;

interface ParseCsvBody {
  mode: 'parse';
  source: 'csv';
  rows: Record<string, string>[];
  mapping?: Record<string, string>;
  headers?: string[];
}
interface ParseDocBody {
  mode: 'parse';
  source: 'document';
  base64Data: string;
  mediaType: string;
}
interface CommitBody {
  mode: 'commit';
  companyId: string;
  jobs: ProposedJob[];
  sessionId?: string;
  asOfDate?: string;
}
type Body = ParseCsvBody | ParseDocBody | CommitBody;

export async function POST(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // ── PARSE (preview) ─────────────────────────────────────────────────────────
  if (body.mode === 'parse') {
    if (body.source === 'csv') {
      if (!Array.isArray(body.rows) || body.rows.length === 0) {
        return NextResponse.json({ error: 'No rows to import' }, { status: 400 });
      }
      if (body.rows.length > MAX_ROWS) {
        return NextResponse.json({ error: `Import is limited to ${MAX_ROWS} rows per file` }, { status: 400 });
      }
      const headers = body.headers ?? Object.keys(body.rows[0] ?? {});
      const mapping = body.mapping && Object.keys(body.mapping).length > 0
        ? body.mapping
        : autoMap(headers, WIP_IMPORT_FIELDS);

      const { jobs, skipped, rowErrors } = normalizeWipCsvRows(body.rows, mapping);
      if (rowErrors.length > 0) {
        return NextResponse.json({ error: 'The file has invalid rows', errors: rowErrors.slice(0, 200) }, { status: 422 });
      }
      const opening = computeOpeningWip(jobs);
      return NextResponse.json({
        source: 'csv',
        aiUsed: false,
        mapping,
        jobs,
        skipped: skipped.slice(0, 200),
        blockers: wipImportBlockers(jobs),
        schedule: opening.schedule,
        totals: opening.totals,
        subledgerDetail: opening.subledgerDetail,
      });
    }

    if (body.source === 'document') {
      if (!body.base64Data || !body.mediaType) {
        return NextResponse.json({ error: 'Provide the document as base64Data + mediaType' }, { status: 400 });
      }
      const apiKey = getAnthropicApiKey();
      if (!apiKey) {
        return NextResponse.json(
          { error: 'Document parsing is unavailable right now — upload your WIP schedule as a CSV instead.', degraded: true },
          { status: 503 },
        );
      }
      const res = await parseWipDocument(
        { supabase: createAdminSupabase(), anthropicApiKey: apiKey },
        { orgId, userId, base64Data: body.base64Data, mediaType: body.mediaType },
      );
      if (!res.ok) {
        return NextResponse.json({ error: res.error, budgetBlocked: res.budgetBlocked, degraded: true }, { status: res.budgetBlocked ? 503 : 422 });
      }
      const opening = computeOpeningWip(res.jobs);
      return NextResponse.json({
        source: 'document',
        aiUsed: true,
        model: res.model,
        documentNote: res.documentNote,
        jobs: res.jobs,
        blockers: wipImportBlockers(res.jobs),
        schedule: opening.schedule,
        totals: opening.totals,
        subledgerDetail: opening.subledgerDetail,
      });
    }

    return NextResponse.json({ error: 'Unknown parse source' }, { status: 400 });
  }

  // ── COMMIT ──────────────────────────────────────────────────────────────────
  if (body.mode === 'commit') {
    if (!body.companyId) return NextResponse.json({ error: 'Select a company to import jobs into' }, { status: 400 });
    if (!Array.isArray(body.jobs) || body.jobs.length === 0) {
      return NextResponse.json({ error: 'No jobs to import' }, { status: 400 });
    }

    const blockers = wipImportBlockers(body.jobs);
    if (blockers.length > 0) {
      return NextResponse.json({ error: 'Resolve these before importing jobs', blockers }, { status: 422 });
    }

    // Resolve the target company + its rev-rec method (RLS-scoped).
    const { data: loc } = await supabase
      .schema('core').from('locations')
      .select('id, short_code, name, rev_rec_method')
      .eq('id', body.companyId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (!loc) return NextResponse.json({ error: 'Selected company not found' }, { status: 400 });
    const company = loc as { id: string; short_code: string; name: string; rev_rec_method: string | null };

    const revRecMethod = company.rev_rec_method ?? 'PCT_COSTS_INCURRED';

    const created = await createOpeningJobs(supabase, orgId, {
      locationId: company.id,
      jobs: body.jobs,
      revRecMethod,
      userId,
    });

    const opening = computeOpeningWip(body.jobs);

    // Stage the opening WIP totals so the extended tie-out fires + reconciliation lights up.
    let attached: { ok: boolean; reason?: string } | null = null;
    if (body.sessionId) {
      attached = await attachWipSubledgerDetail(supabase, orgId, body.sessionId, opening.subledgerDetail);
    }

    return NextResponse.json({
      success: created.errors.length === 0,
      company: { id: company.id, shortCode: company.short_code, name: company.name },
      revRecMethod,
      createdJobNumbers: created.createdJobNumbers,
      createdCount: created.createdJobNumbers.length,
      errors: created.errors,
      totals: opening.totals,
      subledgerDetail: opening.subledgerDetail,
      // Customer deposits are a liability, never revenue — surfaced for the opening TB.
      customerDepositsCents: opening.totals.customerDepositsCents,
      sessionAttached: attached,
    }, { status: created.errors.length === 0 ? 201 : 207 });
  }

  return NextResponse.json({ error: 'Unknown mode' }, { status: 400 });
}
