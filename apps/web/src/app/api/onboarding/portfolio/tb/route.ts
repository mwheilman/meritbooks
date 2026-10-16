export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requirePortfolioContext } from '@/lib/companies/portfolio/guard';
import { csvToGrid, parseTbGrid } from '@/lib/companies/portfolio/tb-grid';
import { readXlsx } from '@/lib/payroll/xlsx-read';
import type { TbReadResponse } from '@/lib/companies/portfolio/types';

/**
 * POST /api/onboarding/portfolio/tb — read ONE spreadsheet trial balance (multipart `file`:
 * .csv / .tsv / .txt / .xlsx) for the multi-file TB drop.
 *
 * Deterministic, no AI, no writes: finds the table under any QuickBooks-style title rows,
 * returns the title lines (for matching the file to a company), the "as of" date printed
 * in the title, and the rows PRE-SHAPED for the existing conversion API
 * (`POST /api/onboarding/conversion` `{ mapping, rows }`), plus a cents tie-out preview.
 * PDFs / images go through the existing AI reader (`/api/onboarding/import/tb`) instead.
 *
 * Gate: authenticated + settings_acct:edit + resolved org (fail closed).
 */

const MAX_BYTES = 4 * 1024 * 1024; // Vercel function bodies cap at ~4.5MB

export async function POST(req: Request) {
  const ctx = await requirePortfolioContext();
  if (ctx instanceof NextResponse) return ctx;

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get('file');
    file = f instanceof File ? f : null;
  } catch {
    return NextResponse.json({ error: 'Could not read the upload', code: 'UPLOAD_ERROR' }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File is larger than 4 MB — export just the Trial Balance report.', code: 'FILE_TOO_LARGE' }, { status: 400 });
  }

  const name = file.name || 'trial-balance';
  const ext = name.toLowerCase().split('.').pop() ?? '';
  let grid: string[][];
  try {
    if (ext === 'xlsx') {
      const x = readXlsx(Buffer.from(await file.arrayBuffer()));
      grid = x.headers.length > 0 ? [x.headers, ...x.rows] : [];
      if (grid.length === 0) {
        return NextResponse.json({ error: 'Couldn’t read this spreadsheet. Re-save it as .xlsx or .csv and try again.', code: 'UNREADABLE' }, { status: 422 });
      }
    } else if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
      grid = csvToGrid(await file.text());
    } else if (ext === 'xls') {
      return NextResponse.json({ error: 'Old .xls files aren’t supported — re-save as .xlsx or .csv.', code: 'BAD_FILE_TYPE' }, { status: 415 });
    } else {
      return NextResponse.json({ error: `Unsupported file type .${ext}. Use .csv or .xlsx (PDFs go through the AI reader).`, code: 'BAD_FILE_TYPE' }, { status: 415 });
    }
  } catch {
    return NextResponse.json({ error: 'Could not read the file', code: 'UNREADABLE' }, { status: 422 });
  }

  const parsed = parseTbGrid(grid);
  if (parsed.error) {
    return NextResponse.json(
      { error: parsed.error, code: 'NO_TABLE', titleLines: parsed.titleLines, detectedAsOf: parsed.detectedAsOf },
      { status: 422 },
    );
  }

  const body: TbReadResponse = {
    fileName: name,
    titleLines: parsed.titleLines,
    detectedAsOf: parsed.detectedAsOf,
    mapping: parsed.mapping,
    rows: parsed.rows,
    totalDebitCents: parsed.totalDebitCents,
    totalCreditCents: parsed.totalCreditCents,
    balanced: parsed.balanced,
    excludedCount: parsed.excluded.length,
    excluded: parsed.excluded.slice(0, 100),
    zeroRows: parsed.zeroRows,
  };
  return NextResponse.json(body);
}
