export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parseTrialBalance, TRIAL_BALANCE_EXTRACT_FEATURE, type TrialBalanceLine } from '@/lib/onboarding/tb-import/parse-tb';
import { normalizeTrialBalanceSheets, type SpreadsheetTbLine } from '@/lib/onboarding/tb-import/spreadsheet-tb';
import { readXlsxSheets } from '@/lib/import/spreadsheet-xlsx';
import {
  spreadsheetKind,
  readCsvGrid,
  gridToTable,
  centsToPlainDollars,
  type SheetGrid,
} from '@/lib/import/spreadsheet';
import { autoMap } from '@/lib/import/csv';
import { CONVERSION_SOURCE_FIELDS } from '@/lib/onboarding/conversion';
import { requirePermission } from '@/lib/rbac/require-permission';
import { resolveUploadedFile, INTAKE_READABLE_TYPES, mediaTypeFromName } from '@/lib/uploads/resolve-upload';
import { GL_DETAIL_NOT_TB_CODE } from '@/lib/onboarding/tb-import/spreadsheet-tb';

/**
 * POST /api/onboarding/import/tb — DROP-AND-PARSE trial-balance import.
 *
 * SPREADSHEETS (.xlsx / .csv) are read DETERMINISTICALLY — no AI, no key needed (FPB
 * principles 4 + 10): the real header row is found under any QuickBooks title rows, a
 * blank first header (the account column) is tolerated, "TOTAL" rows are dropped and
 * reported, "(1,234.56)" negatives and Debit/Credit pairs are parsed into cents. When
 * the columns can't be recognized, the raw table comes back with a suggested column
 * match so the person can match columns by hand (never a dead end). Writes nothing.
 *
 * INGRESS: multipart `file` (direct drop) OR JSON `{ storagePath }` — the Smart Intake
 * handoff (FPB §5), read via resolveUploadedFile from this org's `intake/{orgId}/…`
 * prefix only. A QuickBooks General Ledger DETAIL export is recognized and answered
 * with a plain "we need the Trial Balance" message (code GL_DETAIL_NOT_TB).
 *
 * DOCUMENTS (PDF/JPEG/PNG/WebP) are
 * run through the Core AI gateway (feature TRIAL_BALANCE_EXTRACT, metered +
 * budget-capped per tenant), and returns the PROPOSED rows PRE-SHAPED for the EXISTING
 * historical-conversion path (`POST /api/onboarding/conversion`, body `{ mapping, rows }`).
 * The UI reviews the proposed rows, then hands them — together with the chosen company
 * and as-of date — to the conversion route, which does the source→COA mapping, the
 * tie-out gate, and the balanced OPENING_BALANCE posting.
 *
 * Canon §3 boundary: this is AI PROPOSING facts — it WRITES NOTHING to the ledger or
 * any conversion session. Its only write is a single `ai_decisions` PROPOSED audit row
 * (feature TRIAL_BALANCE_EXTRACT, org-scoped) for explainability, mirroring the debt and
 * statement parse routes. The document is TRANSIENT — decoded and extracted in-request,
 * never persisted here. AI proposes; a human confirms via the existing conversion path.
 *
 * Access: authenticated org context (fail closed 400 when no org). RLS enforces tenant
 * isolation on both the gateway metering and the audit write.
 *
 * The `{ mapping, rows }` output matches the conversion route's `CreateBody`: `mapping`
 * is `{ [conversionFieldKey]: headerName }` (keys = CONVERSION_SOURCE_FIELDS keys —
 * `source_account`, `source_name`, `debit_cents`, `credit_cents`) and `rows` is an array
 * of `Record<string,string>` keyed by those header names, with DOLLAR-denominated amounts
 * (the conversion route's `money` coercion converts dollars → cents). `amount_cents` is
 * intentionally left unmapped: we emit explicit Debit/Credit columns.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Human-facing header names used as the CSV-equivalent column keys in the emitted rows. */
const HEADER = {
  account: 'Account',
  name: 'Account Name',
  debit: 'Debit',
  credit: 'Credit',
} as const;

/**
 * The mapping the conversion route (`CreateBody.mapping`) expects: its CONVERSION_SOURCE_FIELDS
 * keys pointed at the header names present in our `rows`. `amount_cents` is omitted (we emit
 * separate Debit/Credit columns, so `hasAmountColumn` stays false there).
 */
const CONVERSION_MAPPING: Record<string, string> = {
  source_account: HEADER.account,
  source_name: HEADER.name,
  debit_cents: HEADER.debit,
  credit_cents: HEADER.credit,
};

/** Shape one normalized TB line into a conversion `rows` entry (dollar strings). */
/** Shape one spreadsheet TB line into a conversion `rows` entry (dollar strings, no float math). */
function spreadsheetLineToRow(line: SpreadsheetTbLine): Record<string, string> {
  return {
    [HEADER.account]: line.accountNumber ?? line.accountName,
    [HEADER.name]: line.accountName,
    [HEADER.debit]: line.debitCents ? centsToPlainDollars(line.debitCents) : '',
    [HEADER.credit]: line.creditCents ? centsToPlainDollars(line.creditCents) : '',
  };
}

/**
 * Deterministic spreadsheet path. Returns the same `{ mapping, rows }` contract as the
 * document path (plus `rowNumbers` so messages point at the real file row).
 */
async function handleSpreadsheet(file: IncomingFile, kind: 'xlsx' | 'csv'): Promise<NextResponse> {
  let sheets: SheetGrid[];
  try {
    if (kind === 'xlsx') {
      sheets = await readXlsxSheets(file.bytes);
    } else {
      sheets = [{ name: file.name, grid: readCsvGrid(new TextDecoder('utf-8').decode(file.bytes)) }];
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'We could not read that file.', code: 'UNREADABLE' },
      { status: 400 },
    );
  }

  const tb = normalizeTrialBalanceSheets(sheets);
  // A QuickBooks General Ledger DETAIL export is transactions, not balances — say so
  // plainly (with the exact export steps) instead of mis-reading it as a TB.
  if (!tb.ok && tb.code === GL_DETAIL_NOT_TB_CODE) {
    return NextResponse.json({ error: tb.error, code: GL_DETAIL_NOT_TB_CODE, needsTrialBalance: true }, { status: 422 });
  }
  if (tb.ok) {
    const debitTotal = tb.lines.reduce((s, l) => s + l.debitCents, 0);
    const creditTotal = tb.lines.reduce((s, l) => s + l.creditCents, 0);
    return NextResponse.json({
      source: 'spreadsheet',
      mapping: CONVERSION_MAPPING,
      headers: [HEADER.account, HEADER.name, HEADER.debit, HEADER.credit],
      rows: tb.lines.map(spreadsheetLineToRow),
      rowNumbers: tb.lines.map((l) => l.row),
      detected: { sheetName: tb.sheetName, headerRow: tb.headerRow, columns: tb.columns, titleLines: tb.titleLines },
      asOfDateHint: tb.asOfDateHint,
      dropped: tb.dropped.slice(0, 200),
      tieOut: {
        balanced: debitTotal === creditTotal,
        totalDebitCents: debitTotal,
        totalCreditCents: creditTotal,
        differenceCents: debitTotal - creditTotal,
      },
      meta: { fileName: file.name, lineCount: tb.lines.length, droppedCount: tb.dropped.length },
    });
  }

  // Columns not recognized → hand back the raw table so the person matches columns.
  const sheet = sheets.find((s) => s.grid.some((r) => r.length > 0));
  if (!sheet) return NextResponse.json({ error: 'That file is empty.', code: 'EMPTY' }, { status: 422 });
  const headerIdx = Math.max(0, sheet.grid.findIndex((r) => r.filter((c) => c !== '').length >= 2));
  const table = gridToTable(sheet.grid, headerIdx);
  if (table.rows.length === 0) {
    return NextResponse.json({ error: tb.error, code: 'NO_ROWS' }, { status: 422 });
  }
  return NextResponse.json({
    source: 'spreadsheet-raw',
    notice: tb.error,
    mapping: autoMap(table.headers, CONVERSION_SOURCE_FIELDS),
    headers: table.headers,
    rows: table.rows,
    rowNumbers: table.rowNumbers,
    asOfDateHint: null,
    dropped: [],
    meta: { fileName: file.name, lineCount: table.rows.length, droppedCount: 0 },
  });
}

/** The uploaded file, from either ingress shape (multipart `file` or JSON `{ storagePath }`). */
interface IncomingFile {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
}

/**
 * Read the upload. JSON `{ storagePath }` is the Smart Intake handoff (FPB §5): the
 * file was already uploaded once to `intake/{orgId}/…` — read it from storage, never
 * ask for it again. Multipart `file` is the direct drop.
 */
async function readIncomingFile(request: Request, orgId: string): Promise<IncomingFile | NextResponse> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const resolved = await resolveUploadedFile(request, orgId, { allowedTypes: INTAKE_READABLE_TYPES });
    if (resolved instanceof NextResponse) return resolved;
    return {
      name: resolved.fileName,
      type: resolved.mediaType,
      size: resolved.sizeBytes,
      bytes: new Uint8Array(Buffer.from(resolved.base64Data, 'base64')),
    };
  }
  try {
    const formData = await request.formData();
    const upload = formData.get('file');
    if (!upload || typeof upload === 'string') {
      return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
    }
    return {
      name: upload.name || 'trial-balance',
      type: upload.type || '',
      size: upload.size,
      bytes: new Uint8Array(await upload.arrayBuffer()),
    };
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }
}

function toConversionRow(line: TrialBalanceLine): Record<string, string> {
  return {
    [HEADER.account]: line.account_number ?? line.account_name,
    [HEADER.name]: line.account_name,
    [HEADER.debit]: line.debit != null ? String(line.debit) : '',
    [HEADER.credit]: line.credit != null ? String(line.credit) : '',
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Reading a trial balance is the first step of preparing the opening entry.
  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  // ── Spreadsheets first: deterministic, no AI needed ──────────────────────────
  const incoming = await readIncomingFile(request, orgId);
  if (incoming instanceof NextResponse) return incoming;
  const upload = incoming;
  if (upload.size > MAX_BYTES) {
    return NextResponse.json({ error: 'That file is larger than 10 MB. Export just the trial balance report.', code: 'FILE_TOO_LARGE' }, { status: 400 });
  }
  const kind = spreadsheetKind(upload.name, upload.type);
  if (kind === 'xls') {
    return NextResponse.json({
      error: 'That is an older Excel (.xls) file. In Excel choose File → Save As → Excel Workbook (.xlsx), or export a CSV, and drop it here again.',
      code: 'OLD_XLS',
    }, { status: 400 });
  }
  if (kind === 'xlsx' || kind === 'csv') return handleSpreadsheet(upload, kind);

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'Reading PDFs and photos needs AI, which is switched off right now. Export the trial balance from your old system as Excel (.xlsx) or CSV instead — those work without AI.',
        code: 'NO_API_KEY',
      },
      { status: 503 },
    );
  }

  // ── Read the uploaded file (PDF/image, max 10MB) ─────────────────────────────
  let base64Data: string;
  let mediaType: string;
  let fileName: string;
  try {
    const file = upload;

    fileName = file.name || 'trial-balance';
    mediaType = file.type || mediaTypeFromName(fileName);
    if (!ALLOWED.includes(mediaType)) {
      return NextResponse.json(
        { error: 'We can read Excel (.xlsx), CSV, PDF, or a photo (JPEG/PNG). Please export your trial balance in one of those.', code: 'BAD_FILE_TYPE' },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }
    base64Data = Buffer.from(file.bytes).toString('base64');
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  // ── Extract through the metered gateway ──────────────────────────────────────
  const result = await parseTrialBalance({ supabase, anthropicApiKey: apiKey }, { orgId, userId, base64Data, mediaType });
  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' },
      { status },
    );
  }

  const rows = result.lines.map(toConversionRow);

  // ── Log the proposal to the AI decision rail (PROPOSED) for traceability ─────
  // Read-only w.r.t. the ledger and conversion sessions — nothing is posted here.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: TRIAL_BALANCE_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Trial-balance import — ${fileName}: ${result.lines.length} account lines`.slice(0, 2000),
        proposed_output: {
          kind: 'trial_balance_extraction',
          file_name: fileName,
          line_count: result.lines.length,
          total_debit_cents: result.totalDebitCents,
          total_credit_cents: result.totalCreditCents,
          difference_cents: result.differenceCents,
          balanced: result.balanced,
          document_note: result.documentNote,
          dropped: result.dropped,
          mapping: CONVERSION_MAPPING,
          rows,
        },
        reasoning:
          'Account balances extracted from an uploaded prior-system trial balance; proposed for human review. Confirmed rows flow through the existing historical-conversion path (POST /api/onboarding/conversion), which does the source→COA mapping, the tie-out gate, and the balanced opening entry — the model never posts a ledger entry.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[import/tb] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  // ── Return the proposal PRE-SHAPED for the conversion route's `{ mapping, rows }` ──
  return NextResponse.json({
    // Feed these two straight into POST /api/onboarding/conversion (add companyId + asOfDate).
    mapping: CONVERSION_MAPPING,
    rows,
    // Review context for the UI (the tie-out here is informational; the conversion route
    // re-derives the authoritative, mapping-aware tie-out and gates go-live on it).
    tieOut: {
      balanced: result.balanced,
      totalDebitCents: result.totalDebitCents,
      totalCreditCents: result.totalCreditCents,
      differenceCents: result.differenceCents,
    },
    lines: result.lines,
    dropped: result.dropped,
    documentNote: result.documentNote,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      extractionMs: result.extractionMs,
      lineCount: result.lines.length,
      droppedCount: result.dropped.length,
    },
  });
}
