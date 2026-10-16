export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolveUploadedFile, SPREADSHEET_TYPES } from '@/lib/uploads/resolve-upload';
import { isOrgIntakePath } from '@/lib/uploads/paths';
import { readSheetRows } from '@/lib/onboarding/intake/sheet';

/**
 * POST /api/onboarding/intake/read — hand a dropped spreadsheet to a receiver WITHOUT a
 * re-upload. Body: `{ storagePath }` (an object under this org's `intake/{orgId}/`).
 * Returns the header-keyed rows (`{ headers, rows }`, QuickBooks title rows skipped) so
 * the A/R and A/P review sections can preview the file the user dropped in Smart
 * Intake exactly as if it had been dropped on them. CSV / TXT / XLSX only.
 *
 * READ-ONLY: writes nothing. Org-scoped by path prefix (resolveUploadedFile enforces it).
 */

const MAX_ROWS = 20_000;

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

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

  const resolved = await resolveUploadedFile(request, orgId, { allowedTypes: SPREADSHEET_TYPES });
  if (resolved instanceof NextResponse) return resolved;

  const parsed = readSheetRows(Buffer.from(resolved.base64Data, 'base64'), resolved.mediaType, resolved.fileName);
  if (parsed.headers.length === 0) {
    return NextResponse.json(
      { error: 'We couldn’t read this spreadsheet. Re-save it as .xlsx or export a CSV and drop it again.', code: 'UNREADABLE' },
      { status: 422 },
    );
  }
  if (parsed.rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `Files are limited to ${MAX_ROWS.toLocaleString()} rows`, code: 'TOO_MANY_ROWS' }, { status: 400 });
  }
  return NextResponse.json({ headers: parsed.headers, rows: parsed.rows, fileName: resolved.fileName });
}
