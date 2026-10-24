export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { assertWriteScope } from '@/lib/db/scoped-writer';
import { updateIntelligenceBody, type UpdateIntelligenceBody } from '@/lib/validations/document-intelligence';
import { intelDeps } from '@/lib/documents/intelligence/server';
import { changeType, dismissDocument, linkExisting, loadIntel, setCompany } from '@/lib/documents/intelligence/service';
import { resolveRecord } from '@/lib/documents/intelligence/records';
import { draftAuthorizer, errorResponse, guardCenter, guardRecord, maskForeignDuplicates, noOrg } from '@/lib/documents/intelligence/route-auth';
import { presentIntel, presentProposalSummary } from '@/lib/documents/intelligence/present';
import type { IntelligenceDto } from '@/lib/documents/intelligence/types';

/**
 * POST /api/documents/intelligence/update — a person's decision on a document:
 *
 *   change_type  { doc_class }            re-route (other kinds' pending proposals superseded)
 *   set_company  { location_id }          the company it belongs to (proposals follow)
 *   dismiss      { note? }                not something to file; stops proposals + retries
 *   link         { target_type, target_id } link to an existing record (two-way)
 *
 * The document must be RLS-visible; the company / record must be inside the caller's
 * client scope (enforce mode refuses). Center gate for all; `link` also needs the
 * record's module gate; a re-route only makes a module draft when the caller holds that
 * module's gate too (draftAuthorizer). Responses: DTO columns, TIN-redacted, no payload.
 */
export const POST = apiHandler(updateIntelligenceBody, async (body: UpdateIntelligenceBody, { userId, orgId, supabase }) => {
  const route = '/api/documents/intelligence/update';
  const guard = await guardCenter(userId, route);
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const deps = intelDeps();
  const canDraft = draftAuthorizer({ userId, orgId, supabase, route });
  const out = async (intel: IntelligenceDto | null): Promise<IntelligenceDto | null> => (intel ? (await maskForeignDuplicates(supabase, [presentIntel(intel)]))[0] : null);
  try {
    const { data: visible } = await supabase.from('documents').select('id').eq('id', body.document_id).maybeSingle();
    if (!visible) return NextResponse.json({ error: 'Document not found', code: 'NOT_FOUND' }, { status: 404 });
    const current = await loadIntel(deps.db, orgId, body.document_id);
    // The document's current company must be in the caller's scope to change anything.
    await assertWriteScope(supabase, orgId, [current?.location_id ?? null]);

    switch (body.action) {
      case 'change_type': {
        const r = await changeType(deps, { orgId, documentId: body.document_id, userId, docClass: body.doc_class, canDraft });
        return NextResponse.json({ intelligence: await out(r.intelligence), proposals: r.proposals.map(presentProposalSummary), message: r.message });
      }
      case 'set_company': {
        await assertWriteScope(supabase, orgId, [body.location_id]);
        const r = await setCompany(deps, { orgId, documentId: body.document_id, userId, locationId: body.location_id, canDraft });
        return NextResponse.json({ intelligence: await out(r.intelligence), proposals: r.proposals.map(presentProposalSummary), message: r.message });
      }
      case 'dismiss': {
        const intelligence = await dismissDocument(deps, { orgId, documentId: body.document_id, userId, note: body.note ?? null });
        return NextResponse.json({ intelligence: await out(intelligence), message: 'Dismissed — nothing will be proposed for this document.' });
      }
      case 'link': {
        const g = guardRecord(userId, body.target_type, route);
        if (!g) return NextResponse.json({ error: 'That record type cannot be linked.', code: 'BAD_TARGET' }, { status: 400 });
        const rg = await g;
        if (!rg.ok) return rg.response;
        const rec = await resolveRecord(deps.db, orgId, body.target_type, body.target_id);
        if (!rec) return NextResponse.json({ error: 'That record was not found.', code: 'TARGET_NOT_FOUND' }, { status: 404 });
        await assertWriteScope(supabase, orgId, [rec.locationId]);
        const r = await linkExisting(deps, { orgId, documentId: body.document_id, userId, targetType: body.target_type, targetId: body.target_id });
        return NextResponse.json({ label: r.label, message: `Linked to ${r.label}.` });
      }
    }
  } catch (e) {
    return errorResponse(e, 'Failed to update the document');
  }
});
