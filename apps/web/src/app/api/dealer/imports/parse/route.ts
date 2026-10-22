export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { AI_UNAVAILABLE_MESSAGE, getAnthropicApiKey } from '@/lib/ai/gateway';
import { linkSourceDocument, storeSourceDocument } from '@/lib/documents/store-source';
import { DEALER_PERMS, openDealerContext } from '@/lib/dealer/service/context';
import { dealerErrorResponse } from '@/lib/dealer/service/errors';
import { createImportBatch, updateImportBatch } from '@/lib/dealer/service/imports';
import { aiFeatureForKind, parseDealerDocument, type DealerAiInput } from '@/lib/dealer/imports/ai-parse';
import { classifyUpload, maybeAutoImportStatement, mimeFor, readForMapping, spreadsheetToText } from '@/lib/dealer/imports/server';
import { looksTabular, textToGrid } from '@/lib/dealer/imports/mapping';
import { isStatementKind } from '@/lib/dealer/imports/fields';
import { MAX_IMPORT_BYTES, type ParseResponse } from '@/lib/dealer/imports/protocol';

/**
 * POST /api/dealer/imports/parse   (multipart)
 *   file? | text?   the upload (CSV / XLSX / PDF / image) or pasted email-body text
 *   locationId      the client
 *   fileKind        UNITS | DEALS | WARRANTY | LENDER_STATEMENT | LENDER_AUDIT | OEM_STATEMENT | PROGRAMS | OPENING
 *   sourceSystem?   where the file came from (dealer system / lender / manufacturer) — free text
 *   lineId?         floor-plan line (lender statements: lets the autonomy dial auto-import)
 *   oemVendorId?    manufacturer (OEM statements: same)
 *   useAi?          "1" = have the AI read a spreadsheet instead of mapping columns
 *
 * Order (FPB §8): authorize → retain the SOURCE file (before any AI) → open an import
 * batch (UPLOADED) → then either
 *   - spreadsheets / tabular text → { mode: 'mapping', headers, rows, suggestedMapping } (no AI), or
 *   - PDF / image / email text   → AI reader via the Core gateway → { mode: 'ai', proposal, decisionId }
 *     (one PROPOSED ai_decisions row), or the calm { mode: 'ai_unavailable' } when AI is paused.
 * Nothing here creates units, notes, sales or claims. The person reviews and the UI submits
 * through the D1 routes with importBatchId. The only exception is the tenant's A1/A2 dial
 * (default PROPOSE): at AUTO_UNDER_LIMIT a confident statement that FOOTS is recorded as a
 * statement (not posted; matching + sign-off stay human).
 */

const form = z.object({
  locationId: z.string().uuid(),
  fileKind: z.enum(['UNITS', 'DEALS', 'WARRANTY', 'LENDER_STATEMENT', 'LENDER_AUDIT', 'OEM_STATEMENT', 'PROGRAMS', 'OPENING']),
  sourceSystem: z.string().trim().max(100).optional(),
  lineId: z.string().uuid().optional(),
  oemVendorId: z.string().uuid().optional(),
  useAi: z.enum(['0', '1']).optional(),
  text: z.string().max(400_000).optional(),
});

function bad(error: string, code: string, status = 400): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

const UNAVAILABLE_GUIDANCE =
  'AI reading is paused right now. Export the file as CSV or Excel from the source system (or copy the table into a spreadsheet) and upload that — you can map the columns yourself.';

export async function POST(request: Request): Promise<NextResponse> {
  const api = await requireAuthedContext();
  if (api instanceof NextResponse) return api;

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return bad('We could not read the upload. Try again.', 'UPLOAD_ERROR');
  }
  const str = (k: string) => {
    const v = fd.get(k);
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
  };
  const parsed = form.safeParse({
    locationId: str('locationId'), fileKind: str('fileKind'), sourceSystem: str('sourceSystem'),
    lineId: str('lineId'), oemVendorId: str('oemVendorId'), useAi: str('useAi'), text: str('text'),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Please check the upload details.', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors }, { status: 422 });
  }
  const b = parsed.data;
  const fileEntry = fd.get('file');
  const file = fileEntry instanceof File && fileEntry.size > 0 ? fileEntry : null;
  if (!file && !b.text) return bad('Choose a file or paste the statement text.', 'NO_FILE');

  const d = await openDealerContext(api, b.locationId, DEALER_PERMS.imports, '/api/dealer/imports/parse');
  if (d instanceof NextResponse) return d;

  // ── Classify the input ─────────────────────────────────────────────────────
  let fileName: string;
  let cls: ReturnType<typeof classifyUpload>;
  let stored: File;
  if (file) {
    fileName = file.name || 'upload';
    cls = classifyUpload(fileName, file.type || '');
    if (!cls) return bad('Upload a CSV, Excel (.xlsx), PDF or image file.', 'BAD_FILE_TYPE');
    if (cls === 'xls') return bad('Older .xls files can’t be read — save it as .xlsx (or export CSV) and try again.', 'BAD_FILE_TYPE');
    if (file.size > MAX_IMPORT_BYTES) return bad('That file is larger than 15 MB.', 'FILE_TOO_LARGE');
    const mime = mimeFor(cls, file.type || '', fileName);
    // Store with the MIME the extension implies (Documents only accepts known types).
    stored = file.type === mime ? file : new File([await file.arrayBuffer()], fileName, { type: mime });
  } else {
    fileName = 'pasted-text.txt';
    cls = 'text';
    stored = new File([b.text!], fileName, { type: 'text/plain' });
  }

  try {
    // ── Retain the source BEFORE any AI (kept even when AI is paused / fails) ──
    const doc = await storeSourceDocument({
      supabase: api.supabase, orgId: d.orgId, userId: d.userId, file: stored,
      docType: isStatementKind(b.fileKind) ? 'STATEMENT' : 'OTHER', entityType: 'dealer_import_batch', entityId: null,
    });
    const sourceDocumentId = doc?.documentId ?? null;

    const batch = await createImportBatch(d, {
      sourceSystem: b.sourceSystem ?? 'File upload', fileKind: b.fileKind, fileName, documentId: sourceDocumentId,
    });
    if (sourceDocumentId) await linkSourceDocument(api.supabase, sourceDocumentId, 'dealer_import_batch', batch.id);
    const base = { batchId: batch.id, sourceDocumentId, fileName };

    const bytes = cls === 'text' ? null : await stored.arrayBuffer();
    const text = cls === 'text' ? (file ? new TextDecoder().decode(await stored.arrayBuffer()) : b.text!) : cls === 'csv' ? new TextDecoder().decode(bytes!) : null;
    const wantsAi = b.useAi === '1';

    const toMapping = async (aiNotice: string | null): Promise<NextResponse> => {
      const m = await readForMapping(b.fileKind, { cls: cls as 'xlsx' | 'csv' | 'text', bytes: bytes ?? undefined, text: text ?? undefined });
      await updateImportBatch(d, batch.id, { rowCount: m.totalRows });
      const body: ParseResponse = { mode: 'mapping', ...base, ...m, aiNotice };
      return NextResponse.json({ data: body });
    };

    // Spreadsheets map without AI unless the person asked the AI to read it.
    if ((cls === 'xlsx' || cls === 'csv') && !wantsAi) return await toMapping(null);

    // Pasted / .txt text: a clean table maps without AI.
    const tabularText = cls === 'text' && looksTabular(textToGrid(text ?? ''));
    if (tabularText && !wantsAi) return await toMapping(null);

    const feature = aiFeatureForKind(b.fileKind);
    if (!feature) {
      if (cls === 'xlsx' || cls === 'csv' || tabularText) return await toMapping('There is no document reader for this kind of import, so map the columns instead.');
      await updateImportBatch(d, batch.id, { status: 'FAILED', errors: ['No document reader for this kind — upload CSV or Excel.'] });
      const body: ParseResponse = { mode: 'unsupported', ...base, message: 'Reading this kind of file as a document isn’t supported — export it as CSV or Excel and upload that.' };
      return NextResponse.json({ data: body });
    }

    const unavailable = async (): Promise<NextResponse> => {
      if (cls === 'xlsx' || cls === 'csv' || tabularText) return toMapping(`${AI_UNAVAILABLE_MESSAGE} Map the columns below instead.`);
      const body: ParseResponse = { mode: 'ai_unavailable', ...base, unavailable: true, code: 'AI_UNAVAILABLE', message: UNAVAILABLE_GUIDANCE };
      return NextResponse.json({ data: body });
    };

    const key = getAnthropicApiKey();
    if (!key) return await unavailable();

    let input: DealerAiInput;
    if (cls === 'pdf') input = { type: 'pdf', base64: Buffer.from(bytes!).toString('base64') };
    else if (cls === 'image') input = { type: 'image', base64: Buffer.from(bytes!).toString('base64'), mediaType: stored.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' };
    else if (cls === 'xlsx' || cls === 'csv') input = { type: 'text', text: await spreadsheetToText(cls, bytes!), label: `Spreadsheet ${fileName}` };
    else input = { type: 'text', text: text ?? '', label: file ? `File ${fileName}` : 'Pasted email text' };

    const result = await parseDealerDocument({ supabase: api.supabase, anthropicApiKey: key }, { orgId: d.orgId, userId: d.userId, kind: b.fileKind, input });
    if (!result.ok) {
      if (result.unavailable || result.budgetBlocked) return await unavailable();
      await updateImportBatch(d, batch.id, { status: 'FAILED', errors: [result.error] });
      if (result.unsupported) {
        const body: ParseResponse = { mode: 'unsupported', ...base, message: result.error };
        return NextResponse.json({ data: body });
      }
      return NextResponse.json({ error: `The document could not be read: ${result.error}`, code: 'PARSE_FAILED', details: base }, { status: 422 });
    }

    const { proposal } = result;
    await updateImportBatch(d, batch.id, { rowCount: proposal.rows.length });

    // FPB A1/A2: the tenant's dial may record a confident, footing statement itself.
    const auto = isStatementKind(b.fileKind)
      ? await maybeAutoImportStatement(d, {
          kind: b.fileKind, feature, proposal, lineId: b.lineId ?? null, oemVendorId: b.oemVendorId ?? null, batchId: batch.id, documentId: sourceDocumentId,
        })
      : { imported: null, reason: null };

    // ── Decision log: one PROPOSED row per AI read (AC16) ───────────────────────
    let decisionId: string | null = null;
    try {
      // ai_decisions is SELECT-only for members (migration 172): service-role insert after
      // openDealerContext (permission + client proven through RLS), org pinned.
      const { data: dec, error } = await serviceWriter()
        .from('ai_decisions')
        .insert({
          org_id: d.orgId,
          location_id: d.locationId,
          feature,
          model_requested: null,
          model_used: result.model,
          correlation_id: result.correlationId,
          input_summary: `Dealer import (${b.fileKind}) — ${fileName}`.slice(0, 2000),
          proposed_output: {
            kind: b.fileKind,
            file_name: fileName,
            location_id: d.locationId,
            import_batch_id: batch.id,
            source_document_id: sourceDocumentId,
            header: proposal.header,
            row_count: proposal.rows.length,
            low_confidence_count: proposal.rows.filter((r) => r.lowConfidence).length,
            document_note: proposal.documentNote,
            proposals: proposal.rows,
            auto_imported: auto.imported,
          },
          confidence: proposal.confidence,
          reasoning: auto.imported
            ? `Read from an uploaded dealer document. The statement footed and the tenant's autonomy dial recorded it (${auto.imported.reason}). Matching and sign-off stay with a person; nothing posted to the GL.`
            : 'Read from an uploaded dealer document and proposed for human review. Accepted rows are created as PROPOSED records through the dealer pack services; the model never writes a row, a balance or a GL entry.',
          status: 'PROPOSED',
          created_by_user: d.userId,
        })
        .select('id')
        .single();
      if (error) console.error('[dealer-import] decision log failed (non-fatal):', error.message);
      decisionId = (dec as { id: string } | null)?.id ?? null;
    } catch (e) {
      console.error('[dealer-import] decision log threw (non-fatal):', e instanceof Error ? e.message : e);
    }

    const body: ParseResponse = {
      mode: 'ai',
      ...base,
      feature,
      model: result.model,
      decisionId,
      proposal,
      autoImported: auto.imported,
      autonomyReason: auto.reason,
    };
    return NextResponse.json({ data: body });
  } catch (e) {
    if (e instanceof Error && /could not open that Excel file|no rows we can read/i.test(e.message)) {
      return bad(e.message, 'UNREADABLE_FILE', 422);
    }
    return dealerErrorResponse(e);
  }
}
