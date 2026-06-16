export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * POST /api/settings/invoice-branding/logo
 * Multipart upload of a tenant logo to the public `branding` storage bucket.
 * Returns the public URL the caller saves on the entity's invoice template.
 * Validates type + size server-side; the file never lands anywhere but Storage.
 */
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];

export async function POST(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  const orgId = (org as { id: string } | null)?.id;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  const locationId = String(form?.get('location_id') ?? '');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  if (!ALLOWED.includes(file.type)) return NextResponse.json({ error: 'Use a PNG, JPG, SVG, or WebP image' }, { status: 422 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Logo must be under 2 MB' }, { status: 422 });

  const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${orgId}/${locationId || 'org'}-${Date.now()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await supabase.storage
    .from('branding')
    .upload(path, bytes, { contentType: file.type, upsert: true });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const { data: pub } = supabase.storage.from('branding').getPublicUrl(path);
  return NextResponse.json({ url: pub.publicUrl });
}
