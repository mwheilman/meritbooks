export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { requirePermission } from '@/lib/rbac/require-permission';
import { assertWriteScope, isWriteScopeError } from '@/lib/db/scoped-writer';
import { logoSlotSchema } from '@/lib/branding/schema';
import { brandLogoPath, checkDeclaredLength, parseLogoLocation, readCappedBody, validateLogoBytes } from '@/lib/branding/logo-upload';
import { BRANDING_BUCKET, logoContentType } from '@/lib/invoices/templates/logo-url';

/**
 * POST /api/settings/brand/logo?slot=logo|logo_dark|mark&location_id=<uuid?> — upload one
 * brand logo slot (FPB-branding §4.4). Body: multipart with `file`.
 *
 * Order matters (security review): the target (slot, company; none = tenant) comes from the
 * QUERY STRING, so settings_system:edit + the client-scope check run on it BEFORE any body
 * is read; then the size is refused from Content-Length and from a byte-capped stream read
 * (≤ 2 MB file + framing) BEFORE the multipart parser runs. A `location_id` / `slot` form
 * field, if sent, must match the query (never a second, unchecked target).
 *
 * The file's BYTES decide its type (PNG / JPEG magic numbers; SVG, WebP, HTML refused — the
 * PDF can't draw SVG/WebP and we don't serve unsanitized SVG from a public bucket); ≤ 2 MB.
 * Stored in the public `branding` bucket under ${orgId}/brand-…, the only path a renderer
 * accepts (isTenantLogoUrl). Returns the public URL; the caller saves it on the brand
 * profile (which deletes the replaced object). Palette extraction happens in the browser.
 */
export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId, supabase: caller } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // 1. Target from the query string — no body parsing yet.
  const qs = new URL(request.url).searchParams;
  const locationId = parseLogoLocation(qs.get('location_id'));
  if (locationId === undefined) return NextResponse.json({ error: 'Invalid company', code: 'INVALID_LOCATION' }, { status: 422 });
  const slot = logoSlotSchema.safeParse(qs.get('slot') ?? 'logo');
  if (!slot.success) return NextResponse.json({ error: 'Unknown logo slot' }, { status: 422 });

  // 2. Permission + company scope.
  const guard = await requirePermission(userId, 'settings_system', 'edit', { locationId });
  if (!guard.ok) return guard.response;
  try {
    await assertWriteScope(caller, orgId, [locationId]);
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN_SCOPE' }, { status: 403 });
    throw e;
  }

  // 3. Size, before parsing: the declared length, then a hard cap on what we buffer.
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;/i.test(contentType)) {
    return NextResponse.json({ error: 'Send the logo as multipart/form-data.', code: 'UNSUPPORTED_MEDIA_TYPE' }, { status: 415 });
  }
  const declared = checkDeclaredLength(request.headers.get('content-length'));
  if (!declared.ok) return NextResponse.json({ error: declared.error, code: declared.code }, { status: declared.status });
  const body = await readCappedBody(request.body);
  if (!body.ok) return NextResponse.json({ error: 'The logo must be under 2 MB.', code: 'TOO_LARGE' }, { status: 413 });

  // 4. Only now parse the (bounded) multipart body.
  const form = await new Response(body.bytes, { headers: { 'content-type': contentType } }).formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'Could not read the upload.', code: 'BAD_MULTIPART' }, { status: 400 });
  const formLoc = form.get('location_id');
  const formLocId = formLoc === null ? locationId : parseLogoLocation(String(formLoc));
  if (formLocId === undefined || formLocId !== locationId) {
    return NextResponse.json({ error: 'The company in the form does not match the request.', code: 'TARGET_MISMATCH' }, { status: 422 });
  }
  const formSlot = form.get('slot');
  if (formSlot !== null && String(formSlot) !== slot.data) {
    return NextResponse.json({ error: 'The logo slot in the form does not match the request.', code: 'TARGET_MISMATCH' }, { status: 422 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = validateLogoBytes(bytes);
  if (!checked.ok) return NextResponse.json({ error: checked.error, code: checked.code }, { status: checked.code === 'TOO_LARGE' ? 413 : 422 });

  // Storage writes use the service role (the bucket has no member object policies); the
  // identity, permission and company scope are verified above and the path is org-pinned.
  const admin = createAdminSupabase();
  const path = brandLogoPath(orgId, locationId, slot.data, checked.kind, Date.now());
  const { error: upErr } = await admin.storage
    .from(BRANDING_BUCKET)
    .upload(path, bytes, { contentType: logoContentType(checked.kind), upsert: false });
  if (upErr) {
    console.error('[brand/logo] upload failed', upErr.message);
    return NextResponse.json({ error: 'The logo could not be saved. Try again.' }, { status: 500 });
  }
  const { data: pub } = admin.storage.from(BRANDING_BUCKET).getPublicUrl(path);
  return NextResponse.json({ url: pub.publicUrl, slot: slot.data });
}
