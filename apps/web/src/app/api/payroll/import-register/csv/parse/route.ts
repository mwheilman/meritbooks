export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { parseDelimited, guessMapping, type ParsedGrid } from '@/lib/payroll/register-csv';
import { readXlsx } from '@/lib/payroll/xlsx-read';

/**
 * POST /api/payroll/import-register/csv/parse — DETERMINISTIC (no-AI) stage 1.
 *
 * Accepts an uploaded payroll register as CSV / TSV / XLSX (multipart `file`),
 * parses it into a rectangular grid, and returns the headers, the data rows, and a
 * DETERMINISTIC column-mapping guess. No model is called and nothing is written —
 * this is pure structure extraction so the human can review/adjust the column
 * mapping (client-side) before building the balanced entry via the `build` route.
 *
 * XLSX is read byte-wise (`xlsx-read.ts`, dependency-free) on the server (Node);
 * CSV/TSV are decoded to text and parsed with the shared RFC 4180 parser. The file
 * is transient — decoded in-request, never persisted.
 *
 * Access: gated on `payroll:create` (same as the AI import + run-draft path).
 */

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 20_000;

function isXlsx(name: string, type: string): boolean {
  return (
    type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    type === 'application/vnd.ms-excel' ||
    /\.xlsx$/i.test(name)
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'create');
  if (!guard.ok) return guard.response;

  let grid: ParsedGrid;
  let fileName: string;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }
    fileName = file.name || 'payroll-register';
    const buffer = Buffer.from(await file.arrayBuffer());

    if (isXlsx(fileName, file.type || '')) {
      grid = readXlsx(buffer);
      if (grid.headers.length === 0) {
        return NextResponse.json(
          { error: 'Could not read this spreadsheet. Re-save it as .xlsx or export a CSV and try again.', code: 'XLSX_UNREADABLE' },
          { status: 422 },
        );
      }
    } else {
      grid = parseDelimited(buffer.toString('utf8'));
      if (grid.headers.length === 0) {
        return NextResponse.json(
          { error: 'The file has no header row. Ensure the first row names the columns.', code: 'NO_HEADERS' },
          { status: 422 },
        );
      }
    }
  } catch {
    return NextResponse.json({ error: 'Failed to read the uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  if (grid.rows.length === 0) {
    return NextResponse.json(
      { error: 'No data rows found below the header. This looks like an empty register.', code: 'NO_ROWS' },
      { status: 422 },
    );
  }
  const rows = grid.rows.slice(0, MAX_ROWS);

  return NextResponse.json({
    fileName,
    headers: grid.headers,
    rows,
    rowCount: rows.length,
    truncated: grid.rows.length > MAX_ROWS,
    mapping: guessMapping(grid.headers),
  });
}
