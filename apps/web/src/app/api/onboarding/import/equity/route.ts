export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import {
  parseEquityDocument,
  EQUITY_EXTRACT_FEATURE,
  normalizeEquityExtraction,
  csvRowsToOwners,
  ownershipSumCheck,
  reconcileOpeningCapital,
  capTableBlockers,
  commitCapTable,
  loadOpeningCapitalCents,
  type EquityColumnMap,
  type ProposedOwner,
  type OwnershipBasis,
  type ProposedCapTable,
} from '@/lib/onboarding/equity-import';

/**
 * /api/onboarding/import/equity — the equity / cap-table onboarding endpoint.
 *
 * POST — PROPOSE a cap table from a source, three degrade-safe paths:
 *   • multipart `file`  → AI drop-and-parse (feature EQUITY_EXTRACT, gated + metered)
 *   • JSON { rows, columnMap } → CSV column-map (no AI)
 *   • JSON { owners }          → normalize a manual/pasted owner list (no AI)
 *   Returns the proposed owners + the ownership-sum check. Writes ONE `ai_decisions`
 *   PROPOSED row (parse path only) for traceability. Writes NOTHING to the cap table.
 *
 * PUT  — COMMIT the confirmed cap table for an entity: deterministic gate
 *   (capTableBlockers) → persist to core.equity_holders → wire the consolidation
 *   ownership edge → reconcile per-owner capital to the opening-TB equity (report a
 *   variance, never force). Degrade-safe: if the table isn't applied yet it reports
 *   `tableMissing` rather than failing.
 *
 * RLS enforces tenant isolation on every read/write; the document is TRANSIENT.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

interface CsvBody {
  rows?: Record<string, string>[];
  columnMap?: EquityColumnMap;
  owners?: unknown;
}

interface CommitBody {
  entityId?: string;
  owners?: ProposedOwner[];
  ownershipBasis?: OwnershipBasis;
  effectiveDate?: string;
  /** Optional override for the opening equity to reconcile against (cents). */
  openingEquityCents?: number | null;
}

function buildProposalResponse(capTable: ProposedCapTable, extra?: Record<string, unknown>) {
  const check = ownershipSumCheck(capTable.owners, capTable.ownershipBasis);
  return {
    proposal: capTable,
    ownershipCheck: check,
    ...extra,
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const contentType = request.headers.get('content-type') ?? '';

  // ── Path A: JSON (CSV column-map OR manual owner list) — no AI, always works ──
  if (contentType.includes('application/json')) {
    let body: CsvBody;
    try {
      body = (await request.json()) as CsvBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
    }

    if (Array.isArray(body.rows)) {
      if (!body.columnMap || !body.columnMap.name) {
        return NextResponse.json(
          { error: 'Map at least the owner-name column.', code: 'NO_NAME_COLUMN' },
          { status: 422 },
        );
      }
      const owners = csvRowsToOwners(body.rows, body.columnMap);
      const anyPct = owners.some((o) => o.ownership_pct !== null);
      const anyUnits = owners.some((o) => o.units !== null);
      const ownershipBasis: OwnershipBasis = anyPct || !anyUnits ? 'PERCENT' : 'UNITS';
      const capTable: ProposedCapTable = { entityForm: 'LLC', ownershipBasis, owners, snippet: null, documentNote: null };
      return NextResponse.json(buildProposalResponse(capTable, { source: 'csv' }));
    }

    if (body.owners !== undefined) {
      // Normalize a manual/pasted list through the same normalizer.
      const capTable = normalizeEquityExtraction({ cap_table: { owners: body.owners } });
      return NextResponse.json(buildProposalResponse(capTable, { source: 'manual' }));
    }

    return NextResponse.json({ error: 'Provide `rows`+`columnMap` or `owners`.', code: 'EMPTY_BODY' }, { status: 422 });
  }

  // ── Path B: multipart file → AI drop-and-parse ───────────────────────────────
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'AI is not configured — enter the cap table by CSV or manually instead.',
        code: 'NO_API_KEY',
      },
      { status: 503 },
    );
  }

  let base64Data: string;
  let mediaType: string;
  let fileName: string;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
    fileName = file.name || 'document';
    mediaType = file.type || 'application/octet-stream';
    if (!ALLOWED.includes(mediaType)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`, code: 'BAD_FILE_TYPE' },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }
    const buffer = await file.arrayBuffer();
    base64Data = Buffer.from(buffer).toString('base64');
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  const result = await parseEquityDocument({ supabase, anthropicApiKey: apiKey }, { orgId, userId, base64Data, mediaType });
  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' },
      { status },
    );
  }

  // Log the proposal to the AI decision rail (PROPOSED) — nothing written to the cap table.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: EQUITY_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Cap-table extraction — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'equity_extraction',
          file_name: fileName,
          document_note: result.capTable.documentNote,
          cap_table: result.capTable,
        },
        reasoning:
          'Ownership extracted from an uploaded operating agreement / cap table; proposed for human review. Confirmed via the gated equity commit path, which persists the cap table and wires consolidation ownership — the model never creates a holder or a posting.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[equity/import] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json(
    buildProposalResponse(result.capTable, {
      source: 'ai',
      meta: { fileName, model: result.model, decisionId, extractionMs: result.extractionMs },
    }),
  );
}

export async function PUT(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  let body: CommitBody;
  try {
    body = (await request.json()) as CommitBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
  }

  if (!body.entityId) return NextResponse.json({ error: 'Select a company for this cap table.', code: 'NO_ENTITY' }, { status: 400 });
  const owners = Array.isArray(body.owners) ? body.owners : [];
  const ownershipBasis: OwnershipBasis = body.ownershipBasis === 'UNITS' ? 'UNITS' : 'PERCENT';

  // Confirm the entity belongs to the org (RLS also enforces this).
  const { data: loc } = await supabase
    .schema('core').from('locations')
    .select('id')
    .eq('id', body.entityId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!loc) return NextResponse.json({ error: 'Selected company not found.', code: 'ENTITY_NOT_FOUND' }, { status: 400 });

  // Deterministic gate — a real cap table foots to 100% with named owners.
  const blockers = capTableBlockers({ owners, ownershipBasis });
  if (blockers.length > 0) {
    return NextResponse.json({ error: 'Cap table is not ready to save.', code: 'VALIDATION_ERROR', blockers }, { status: 422 });
  }

  const commit = await commitCapTable(supabase, orgId, userId, {
    entityId: body.entityId,
    owners,
    ownershipBasis,
    effectiveDate: body.effectiveDate,
  });

  // Reconcile per-owner capital to the opening-TB equity (report a variance).
  const openingEquityCents =
    body.openingEquityCents !== undefined && body.openingEquityCents !== null
      ? body.openingEquityCents
      : await loadOpeningCapitalCents(supabase, orgId, body.entityId);
  const reconcile = reconcileOpeningCapital(owners, openingEquityCents);

  return NextResponse.json({
    persisted: commit.persisted,
    tableMissing: commit.tableMissing,
    holdersWritten: commit.holdersWritten,
    consolidation: {
      edgesWired: commit.consolidationEdgesWired,
      tableAvailable: commit.consolidationTableAvailable,
    },
    reconcile,
    warnings: commit.warnings,
  });
}
