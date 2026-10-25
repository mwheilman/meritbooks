/**
 * POST /api/onboarding/import/parse — "Drop a file" (also used on step 1 to sniff headers)
 *   multipart: file (CSV / .xlsx, ≤ 4 MB), companyId
 *   → ParseResponse { vendor, headers, headerRow, rowCount, truncated, mapping, unmappedHeaders,
 *                     ai{outcome, mapped}, records (≤ 2000), rowNumbers }
 *
 * Rules auto-map first (vendor aliases for Buildertrend / JobTread / simPRO / Innergy / RFMS /
 * ServiceTitan / spreadsheets). Only when fields are still unmapped and AI is reachable, the
 * model sees the UNMAPPED header names + 5 sample rows and may answer only field-key-or-null.
 * Nothing is stored; the file never leaves this request.
 */
import { boundedInflate } from '@/lib/imports/inflate';
import { FEATURE_IMPORT_MAP, runAiSafe } from '@/lib/ai/gateway';
import { proposeDecision } from '@/lib/ai/decisions';
import { MAP_SYSTEM, buildMapTool, mapPrompt, validateMapAnswer } from '@/lib/onboarding/import/ai-map';
import { unmappedFields, unmappedHeaders } from '@/lib/onboarding/import/automap';
import { MAX_UPLOAD_BYTES, gridFromUpload, tableFromGrid } from '@/lib/onboarding/import/parse';
import { RouteError, json, requireCompany, withOnboarding } from '@/lib/onboarding/route';
import type { AiOutcome, ParseResponse } from '@/lib/onboarding/types';
import { denyUnless } from '@/lib/access/route-guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;


export async function POST(req: Request) {
  return withOnboarding(req, null, async (_body, ctx) => {
    const form = await req.formData().catch(() => null);
    if (!form) throw new RouteError(400, 'NO_FILE', 'Drop a CSV or Excel file.');
    const file = form.get('file');
    const companyId = String(form.get('companyId') ?? '');
    if (companyId) requireCompany(ctx, companyId);
    const denied = await denyUnless('projects.settings', 'configure', companyId || null); if (denied) return denied;
    if (!file || typeof file === 'string') throw new RouteError(400, 'NO_FILE', 'Drop a CSV or Excel file.');
    if (file.size > MAX_UPLOAD_BYTES) throw new RouteError(413, 'TOO_BIG', 'That file is over 4 MB. Export open jobs only, or split it, and drop it again.');

    const bytes = new Uint8Array(await file.arrayBuffer());
    const grid = gridFromUpload(file.name, file.type, bytes, boundedInflate());
    if (!Array.isArray(grid)) throw new RouteError(422, 'UNREADABLE', grid.message);
    const table = tableFromGrid(grid, file.name);
    if (!table.ok) throw new RouteError(422, 'NO_ROWS', table.message);

    let mapping = table.mapping;
    let ai: { outcome: AiOutcome; message: string | null; mapped: number } = { outcome: 'skipped', message: null, mapped: 0 };
    let aiDecisionId: string | null = null;
    const fields = unmappedFields(mapping);
    const headers = table.unmapped;
    if (fields.length > 0 && headers.length > 0 && form.get('ai') !== 'off') {
      const r = await runAiSafe({
        orgId: ctx.tenant.orgId,
        userId: ctx.userId,
        feature: FEATURE_IMPORT_MAP,
        system: MAP_SYSTEM,
        prompt: mapPrompt(headers.slice(0, 40), table.records),
        tool: buildMapTool(headers.slice(0, 40), fields),
        maxTokens: 800,
      });
      if (r.status === 'ok') {
        const extra = validateMapAnswer(r.input, headers.slice(0, 40), fields);
        mapping = { ...mapping, ...extra };
        ai = { outcome: 'used', message: null, mapped: Object.keys(extra).length };
        if (ai.mapped > 0) {
          const d = await proposeDecision(ctx.db, {
            orgId: ctx.tenant.orgId,
            locationId: companyId || null,
            feature: FEATURE_IMPORT_MAP,
            userId: ctx.userId,
            inputSummary: `Map ${headers.length} unmapped columns in ${file.name}`,
            proposedOutput: { dedup_key: `import_map:${companyId}:${file.name}`, mapping: extra, headers: headers.slice(0, 40), fields },
            confidence: 0.6,
            reasoning: 'Header names and five sample rows; the model could only answer a field key or nothing.',
            modelRequested: r.modelRequested, modelUsed: r.modelUsed, correlationId: r.correlationId, tokens: r.tokens, costCents: r.costCents,
          });
          aiDecisionId = d.ok ? d.id : null;
        }
      } else {
        ai = { outcome: r.status === 'blocked' ? 'blocked' : r.status === 'invalid' ? 'invalid' : 'unavailable', message: r.message, mapped: 0 };
      }
    }

    const res: ParseResponse = {
      fileName: file.name,
      vendor: table.vendor,
      headers: table.headers,
      headerRow: table.headerRow,
      rowCount: table.rowCount,
      truncated: table.truncated,
      mapping,
      unmappedHeaders: unmappedHeaders(table.headers, mapping),
      ai,
      records: table.records,
      rowNumbers: table.rowNumbers,
      aiDecisionId,
    };
    return json(res);
  });
}
