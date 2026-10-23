export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { requirePermission } from '@/lib/rbac/require-permission';
import { BRANDING_BUCKET, MAX_LOGO_BYTES, logoContentType, logoExtension, sniffLogoType } from '@/lib/invoices/templates/logo-url';

/**
 * POST /api/settings/invoice-branding/logo
 * Multipart upload of a tenant logo to the public `branding` storage bucket.
 * Returns the public URL the caller saves on the entity's invoice template.
 * Validates size and the file's actual bytes server-side (PNG / JPEG magic numbers — the
 * browser's claimed type and the file name are not trusted); the stored extension and
 * content type come from the detected type. The file never lands anywhere but Storage, in
 * the caller's org folder — the only place invoice templates accept a logo from
 * (lib/invoices/templates/logo-url.ts).
 */
// PNG / JPEG only: the PDF renderer can't draw SVG or WebP (a logo that silently vanishes
// from the printed invoice is worse than a clear upload error).

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  // Logos print on customer documents: the same permission as editing a template.
  const guard = await requirePermission(userId, 'invoices', 'approve');
  if (!guard.ok) return guard.response;

  // Storage writes go through the service role: the `branding` bucket's object
  // policies are a separate surface from table RLS and are not yet configured for
  // the authenticated role. Identity/org are already verified above; the upload
  // path is namespaced by the caller's orgId.
  const supabase = createAdminSupabase();

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  const rawLoc = String(form?.get('location_id') ?? '');
  const locationId = /^[0-9a-f-]{36}$/i.test(rawLoc) ? rawLoc : '';
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  if (file.size > MAX_LOGO_BYTES) return NextResponse.json({ error: 'Logo must be under 2 MB' }, { status: 422 });
  if (file.size === 0) return NextResponse.json({ error: 'That file is empty' }, { status: 422 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_LOGO_BYTES) return NextResponse.json({ error: 'Logo must be under 2 MB' }, { status: 422 });
  const kind = sniffLogoType(bytes);
  if (!kind) return NextResponse.json({ error: 'Use a PNG or JPG image (the PDF can’t print SVG or WebP)' }, { status: 422 });

  const path = `${orgId}/${locationId || 'org'}-${Date.now()}.${logoExtension(kind)}`;
  const { error: upErr } = await supabase.storage
    .from(BRANDING_BUCKET)
    .upload(path, bytes, { contentType: logoContentType(kind), upsert: false });
  if (upErr) {
    console.error('[invoice-branding/logo] upload failed', upErr.message);
    return NextResponse.json({ error: 'The logo could not be saved. Try again.' }, { status: 500 });
  }

  const { data: pub } = supabase.storage.from(BRANDING_BUCKET).getPublicUrl(path);
  return NextResponse.json({ url: pub.publicUrl });
}
