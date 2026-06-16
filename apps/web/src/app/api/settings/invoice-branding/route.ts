export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

type Supa = ReturnType<typeof createAdminSupabase>;

async function getOrgId(supabase: Supa): Promise<string | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * GET /api/settings/invoice-branding
 * Per-entity invoice display options (style, accent color, logo, remit, footer,
 * default message). One row per location in public.invoice_templates; entities
 * without a saved template come back with the emerald/MODERN defaults.
 */
export async function GET() {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const orgId = await getOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: locations } = await supabase
    .schema('core').from('locations')
    .select('id, name, short_code')
    .eq('is_active', true)
    .order('name');

  const { data: templates } = await supabase
    .from('invoice_templates')
    .select('location_id, style, logo_url, accent_color, remit_to, footer_text, default_message')
    .eq('org_id', orgId);

  const byLoc = new Map((templates ?? []).map((t: Record<string, unknown>) => [t.location_id as string, t]));

  const entities = (locations ?? []).map((l: Record<string, unknown>) => {
    const t = byLoc.get(l.id as string) ?? {};
    return {
      locationId: l.id,
      name: l.name,
      shortCode: l.short_code,
      style: (t as Record<string, unknown>).style ?? 'MODERN',
      accentColor: (t as Record<string, unknown>).accent_color ?? '#10b981',
      logoUrl: (t as Record<string, unknown>).logo_url ?? null,
      remitTo: (t as Record<string, unknown>).remit_to ?? '',
      footerText: (t as Record<string, unknown>).footer_text ?? '',
      defaultMessage: (t as Record<string, unknown>).default_message ?? '',
    };
  });

  return NextResponse.json({ entities });
}

const putSchema = z.object({
  location_id: z.string().uuid(),
  style: z.enum(['MODERN', 'CLASSIC', 'MINIMAL', 'BOLD', 'COMPACT']),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #10b981'),
  logo_url: z.string().url().nullable().optional(),
  remit_to: z.string().max(500).optional(),
  footer_text: z.string().max(300).optional(),
  default_message: z.string().max(1000).optional(),
});

/** PUT /api/settings/invoice-branding — upsert one entity's display options. */
export async function PUT(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const orgId = await getOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const parsed = putSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 422 });
  }
  const b = parsed.data;

  const { error } = await supabase
    .from('invoice_templates')
    .upsert({
      org_id: orgId,
      location_id: b.location_id,
      style: b.style,
      accent_color: b.accent_color,
      logo_url: b.logo_url ?? null,
      remit_to: b.remit_to ?? null,
      footer_text: b.footer_text ?? null,
      default_message: b.default_message ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,location_id' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
