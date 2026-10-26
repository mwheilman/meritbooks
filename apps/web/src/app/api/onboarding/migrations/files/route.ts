export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { migrationErrorResponse } from '@/lib/onboarding/migration/server/guard';
import { withProject } from '@/lib/onboarding/migration/server/route-support';
import { stageFile, MAX_FILE_BYTES } from '@/lib/onboarding/migration/server/staging';
import { refreshProject } from '@/lib/onboarding/migration/server/projects';
import { STAGED_ENTITIES, type StagedEntity } from '@/lib/onboarding/migration/types';

/**
 * POST /api/onboarding/migrations/files — multipart: project_id, source_id, slot (the
 * recipe file's entity, optional), file. The file is recognized by its headers (rules
 * only), staged with its SHA-256 and control totals, and never posts anything.
 * Gate: journal_entries:create + the client in the caller's write scope.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  // Refuse an oversized body BEFORE buffering it (formData() reads the whole request into memory).
  // The multipart envelope adds a little over the file itself.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'That file is over 15 MB — export a smaller date range or split it.', code: 'TOO_LARGE' }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Send the file as a form upload.', code: 'BAD_FORM' }, { status: 400 });
  }
  const projectId = String(form.get('project_id') ?? '');
  const sourceId = String(form.get('source_id') ?? '');
  const slot = String(form.get('slot') ?? '');
  const file = form.get('file');
  if (!/^[0-9a-f-]{36}$/i.test(projectId) || !/^[0-9a-f-]{36}$/i.test(sourceId)) return NextResponse.json({ error: 'Missing project or source.', code: 'BAD_REQUEST' }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a file to drop.', code: 'NO_FILE' }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'That file is over 15 MB — export a smaller date range or split it.', code: 'TOO_LARGE' }, { status: 413 });
  const expect = (STAGED_ENTITIES as readonly string[]).includes(slot) ? (slot as StagedEntity) : null;

  const pc = await withProject(ctx, projectId, 'work', '/api/onboarding/migrations/files');
  if (pc instanceof NextResponse) return pc;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const r = await stageFile(pc.supabase, { orgId: pc.orgId, userId: pc.userId }, pc.project, sourceId, { buffer, name: file.name || 'upload', type: file.type || '' }, expect);
    await refreshProject(pc.supabase, pc.orgId, pc.project, { withTies: false });
    return NextResponse.json({ ...r, message: r.duplicate ? 'Already staged — nothing changed.' : `Staged: ${r.label}` });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not stage the file');
  }
}
