export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { isOrgIntakePath, displayNameFromStoragePath } from '@/lib/uploads/paths';
import { mediaTypeFromName } from '@/lib/uploads/resolve-upload';
import { INTAKE_DOC_TYPES, INTAKE_ROUTES, type IntakeDocType } from '@/lib/onboarding/intake/types';
import { buildHandoff } from '@/lib/onboarding/intake/handoff';
import { intelDeps } from '@/lib/documents/intelligence/server';
import { analyzeDocument } from '@/lib/documents/intelligence/service';
import { classFromIntakeType } from '@/lib/documents/intelligence/types';
import { draftAuthorizer } from '@/lib/documents/intelligence/route-auth';
import { presentIntel } from '@/lib/documents/intelligence/present';

/**
 * POST /api/onboarding/intake/file — keep a dropped file in the company's DOCUMENTS.
 *
 * For files Smart Intake can't (yet) put to work automatically — an org chart, an
 * expense policy, a WIP schedule, a lease, anything unrecognized — we never make the
 * user hold on to it. The bytes are ALREADY in storage (uploaded once via
 * uploadForParse), so this only records the `public.documents` metadata row pointing at
 * that object, linked to the company (`entity_type='location'`) with a plain-English
 * note ("we'll use this to set up approval chains later"). No re-upload, no copy.
 *
 * Idempotent per (org, storage_path) — saving the same file twice updates the row.
 * Guarded by settings_acct:edit (the onboarding permission); RLS-scoped write.
 */

const bodySchema = z.object({
  storagePath: z.string().min(1).max(500),
  docType: z.enum(INTAKE_DOC_TYPES as [IntakeDocType, ...IntakeDocType[]]),
  companyId: z.string().uuid().nullish(),
  sizeBytes: z.number().int().nonnegative().nullish(),
  mimeType: z.string().max(200).nullish(),
  /** How Smart Intake typed it (ai | rules | user) and how sure — seeds document intelligence. */
  classSource: z.enum(['ai', 'rules', 'user']).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
});
type Body = z.infer<typeof bodySchema>;

export const POST = apiHandler(bodySchema, async (body: Body, ctx: ApiContext): Promise<NextResponse> => {
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  if (!isOrgIntakePath(body.storagePath, orgId)) {
    return NextResponse.json({ error: 'Invalid file path', code: 'BAD_PATH' }, { status: 403 });
  }

  if (body.companyId) {
    const { data: loc } = await supabase
      .schema('core')
      .from('locations')
      .select('id')
      .eq('id', body.companyId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (!loc) return NextResponse.json({ error: 'Company not found', code: 'COMPANY_NOT_FOUND' }, { status: 400 });
  }

  const handoff = buildHandoff(body.docType, body.storagePath);
  const fileName = displayNameFromStoragePath(body.storagePath);
  const label = INTAKE_ROUTES[body.docType].label;
  const note = handoff.fileNote ?? `${label} — added during onboarding.`;

  const row = {
    org_id: orgId,
    storage_path: body.storagePath,
    file_name: fileName,
    mime_type: body.mimeType?.trim() || mediaTypeFromName(fileName),
    size_bytes: body.sizeBytes ?? null,
    doc_type: handoff.documentType,
    entity_type: body.companyId ? 'location' : null,
    entity_id: body.companyId ?? null,
    uploaded_by_user: userId,
    notes: `Onboarding intake (${label}): ${note}`.slice(0, 2000),
  };

  const { data, error } = await supabase
    .from('documents')
    .upsert(row, { onConflict: 'org_id,storage_path' })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[onboarding/intake/file] save failed:', error?.message);
    return NextResponse.json({ error: 'Could not save the document. Please try again.', code: 'SAVE_FAILED' }, { status: 500 });
  }

  const documentId = (data as { id: string }).id;

  // Document intelligence (FPB-document-intelligence §7.1): route the file to the module
  // it belongs to as a PROPOSAL ("We found a lease — added to Leases for your review").
  // Best-effort: with AI off the rules answer and a retry is queued; never fails the save.
  let found: string | null = null;
  let intelligence: ReturnType<typeof presentIntel> | null = null;
  try {
    // No module draft without the target module's permission + write scope on the company.
    const canDraft = draftAuthorizer({ userId, orgId, supabase: ctx.supabase, route: '/api/onboarding/intake/file' });
    const r = await analyzeDocument(intelDeps(), {
      canDraft,
      orgId,
      documentId,
      userId,
      source: 'onboarding',
      uploadLocationId: body.companyId ?? null,
      preset: { docClass: classFromIntakeType(body.docType), confidence: body.confidence ?? (body.classSource === 'user' ? 1 : 0.6), source: body.classSource ?? 'rules' },
    });
    // Browser projection: redacted, no payload / internal fields.
    intelligence = r.intelligence ? presentIntel(r.intelligence) : null;
    found = r.skipped ? null : r.message;
  } catch (e) {
    console.error('[onboarding/intake/file] document intelligence failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({ ok: true, documentId, note, found, intelligence }, { status: 201 });
});
