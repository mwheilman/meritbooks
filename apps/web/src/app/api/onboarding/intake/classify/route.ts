export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { classifyDocument, INTAKE_CLASSIFY_FEATURE } from '@/lib/onboarding/intake/classify';
import { INTAKE_ROUTES } from '@/lib/onboarding/intake/types';
import { classifyByRules, mergeAiAndRules, type AiOpinion } from '@/lib/onboarding/intake/rules';
import { sniffSheet } from '@/lib/onboarding/intake/sheet';
import { buildHandoff } from '@/lib/onboarding/intake/handoff';
import { resolveUploadedFile, INTAKE_READABLE_TYPES, SPREADSHEET_TYPES } from '@/lib/uploads/resolve-upload';
import { displayNameFromStoragePath, isOrgIntakePath, isReadableName } from '@/lib/uploads/paths';

/**
 * POST /api/onboarding/intake/classify — SMART INTAKE v2 classifier.
 *
 * Body: `application/json { storagePath }` — the file the browser already uploaded
 * ONCE via `uploadForParse` (org-scoped `intake/{orgId}/…`). Legacy multipart `file`
 * is still accepted (small PDFs/images) for backward compatibility.
 *
 * Decides WHAT the file is and the ONE next action (the handoff), and returns the
 * storage path so the receiver reads the same object — the user never re-uploads.
 *
 *   1. Spreadsheets / CSV are sniffed deterministically (header + title-row keywords).
 *   2. PDFs / images (and sheets the rules can't place) go to the Core AI gateway
 *      (feature INTAKE_CLASSIFY, metered + budget-capped) WHEN AI is available.
 *   3. AI off / over budget / failed → file-name + content rules (FPB principle 10).
 *      This route NEVER 503s for "AI off" — every file gets a best guess.
 *   4. Formats we can't open (Word, PowerPoint, .xls …) are classified by name only.
 *
 * Canon boundary: AI/rules PROPOSE a routing decision only; nothing is written to the
 * ledger. The only write is a best-effort `ai_decisions` PROPOSED row when AI ran.
 */

interface ResolvedInput {
  storagePath: string | null;
  fileName: string;
  mediaType: string | null;
  base64Data: string | null;
  sizeBytes: number | null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // ── Resolve the file (by storage path, or legacy multipart) ────────────────
  let input: ResolvedInput;
  const isJson = (request.headers.get('content-type') ?? '').includes('application/json');
  if (isJson) {
    let storagePath = '';
    try {
      const body = (await request.clone().json()) as { storagePath?: unknown };
      storagePath = typeof body?.storagePath === 'string' ? body.storagePath : '';
    } catch {
      return NextResponse.json({ error: 'Invalid request body', code: 'BAD_BODY' }, { status: 400 });
    }
    if (!isOrgIntakePath(storagePath, orgId)) {
      return NextResponse.json({ error: 'Invalid file path', code: 'BAD_PATH' }, { status: 403 });
    }
    const fileName = displayNameFromStoragePath(storagePath);
    if (!isReadableName(fileName)) {
      // Word / PowerPoint / .xls / anything we can't open: classify by name only.
      input = { storagePath, fileName, mediaType: null, base64Data: null, sizeBytes: null };
    } else {
      const resolved = await resolveUploadedFile(request, orgId, { allowedTypes: INTAKE_READABLE_TYPES });
      if (resolved instanceof NextResponse) return resolved;
      input = {
        storagePath,
        fileName,
        mediaType: resolved.mediaType,
        base64Data: resolved.base64Data,
        sizeBytes: resolved.sizeBytes,
      };
    }
  } else {
    const resolved = await resolveUploadedFile(request, orgId, { allowedTypes: INTAKE_READABLE_TYPES });
    if (resolved instanceof NextResponse) return resolved;
    input = {
      storagePath: resolved.storagePath,
      fileName: resolved.fileName,
      mediaType: resolved.mediaType,
      base64Data: resolved.base64Data,
      sizeBytes: resolved.sizeBytes,
    };
  }

  // ── 1. Deterministic rules (always) ────────────────────────────────────────
  const isSheet = !!input.mediaType && SPREADSHEET_TYPES.includes(input.mediaType);
  let textSample: string | null = null;
  let cells: string[] = [];
  if (isSheet && input.base64Data) {
    const sniff = sniffSheet(Buffer.from(input.base64Data, 'base64'), input.mediaType ?? '', input.fileName);
    cells = sniff.cells;
    textSample = sniff.textSample;
  }
  const rules = classifyByRules({ fileName: input.fileName, cells });

  // ── 2. AI (when available and useful) ──────────────────────────────────────
  // Sheets the rules already placed confidently skip the AI call (cheaper, faster, and
  // deterministic). PDFs/images always ask the AI when it is on.
  const apiKey = getAnthropicApiKey();
  const aiUseful = !!input.base64Data && (!isSheet || rules.confidence < 0.75);
  let ai: AiOpinion | null = null;
  let aiStatus: 'used' | 'off' | 'failed' | 'skipped' = apiKey ? 'skipped' : 'off';
  let model: string | null = null;
  let correlationId: string | null = null;
  if (apiKey && aiUseful && input.base64Data && input.mediaType) {
    const res = await classifyDocument(
      { supabase, anthropicApiKey: apiKey },
      { orgId, userId, base64Data: input.base64Data, mediaType: input.mediaType, textSample: isSheet ? textSample : null },
    );
    if (res.ok) {
      ai = { docType: res.classification.docType, confidence: res.classification.confidence, note: res.classification.note };
      aiStatus = 'used';
      model = res.model;
      correlationId = res.correlationId;
    } else {
      aiStatus = 'failed';
      console.warn('[onboarding/intake/classify] AI unavailable, using rules:', res.error);
    }
  }

  const final = mergeAiAndRules(ai, rules);
  const route = INTAKE_ROUTES[final.docType];
  const handoff = input.storagePath ? buildHandoff(final.docType, input.storagePath) : null;

  // ── 3. Trace the AI proposal (best-effort; only when the model actually ran) ─
  let decisionId: string | null = null;
  if (aiStatus === 'used') {
    try {
      const { data: dec } = await supabase
        .from('ai_decisions')
        .insert({
          org_id: orgId,
          feature: INTAKE_CLASSIFY_FEATURE,
          model_requested: null,
          model_used: model,
          correlation_id: correlationId,
          input_summary: `Intake classification — ${input.fileName}`.slice(0, 2000),
          proposed_output: {
            kind: 'intake_classification',
            file_name: input.fileName,
            storage_path: input.storagePath,
            doc_type: final.docType,
            label: route.label,
            confidence: final.confidence,
            source: final.source,
            rules_doc_type: rules.docType,
            route: route.route,
            parse_endpoint: route.parseEndpoint,
            note: final.note,
          },
          reasoning:
            'Document classified during onboarding intake to route it to the correct pipeline; proposed for human confirmation. The classifier only decides WHAT the document is and WHERE it goes — the destination parser extracts its contents, and nothing is written to the ledger here.',
          status: 'PROPOSED',
          created_by_user: userId,
        })
        .select('id')
        .single();
      decisionId = (dec as { id: string } | null)?.id ?? null;
    } catch (e) {
      console.error('[onboarding/intake/classify] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  return NextResponse.json({
    ok: true,
    docType: final.docType,
    label: route.label,
    confidence: final.confidence,
    source: final.source,
    route: route.route,
    parseEndpoint: route.parseEndpoint,
    note: final.note,
    storagePath: input.storagePath,
    handoff,
    meta: {
      fileName: input.fileName,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      ai: aiStatus,
      model,
      decisionId,
    },
  });
}
