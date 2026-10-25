import 'server-only';
/**
 * Render context for a company: brand (pm.doc_brand → public.brand_profiles, mig 190), the
 * logo bytes (only from this tenant's own folder of the public `branding` bucket — the same
 * SSRF rule Books applies), the pack vocabulary (pm.v_vocabulary) and the company's template text.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { vocabularyFrom, type VocabRow } from '@/lib/pm/vocab';
import { todayIso } from '@/lib/time';
import type { TemplateContext, TemplateKey, TemplateSettings } from './types';

const MAX_LOGO = 2 * 1024 * 1024;

/** Only https URLs in <supabase>/storage/v1/object/public/branding/<org>/… are fetched. */
export function isTenantLogoUrl(url: string | null | undefined, orgId: string, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''): boolean {
  if (!url || !supabaseUrl) return false;
  try {
    const u = new URL(url);
    const base = new URL(supabaseUrl);
    return u.protocol === 'https:' && u.host === base.host && u.pathname.startsWith(`/storage/v1/object/public/branding/${orgId}/`) && !u.pathname.includes('..');
  } catch {
    return false;
  }
}

async function fetchLogo(url: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const type = r.headers.get('content-type') ?? '';
    if (!/^image\/(png|jpeg)/.test(type)) return null;
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > MAX_LOGO) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    return b.byteLength > MAX_LOGO ? null : b;
  } catch {
    return null;
  }
}

interface BrandJson { company_name?: string; logo_url?: string | null; primary_color?: string; ink_color?: string }

export async function templateContext(db: SupabaseClient, orgId: string, companyId: string, key: TemplateKey): Promise<TemplateContext> {
  const pm = db.schema('pm');
  const [brandRes, vocabRes, settingsRes] = await Promise.all([
    pm.rpc('doc_brand', { p_location: companyId }),
    pm.from('v_vocabulary').select('location_id, vocab_key, label').eq('location_id', companyId),
    pm.from('doc_template_settings').select('body').eq('location_id', companyId).eq('template_key', key).maybeSingle(),
  ]);
  const b = (brandRes.data ?? {}) as BrandJson;
  const logo = isTenantLogoUrl(b.logo_url, orgId) ? await fetchLogo(b.logo_url as string) : null;
  return {
    brand: { companyName: b.company_name || 'Company', primaryColor: b.primary_color ?? '#2563EB', inkColor: b.ink_color ?? '#0A1628', logo },
    vocab: vocabularyFrom((vocabRes.data ?? []) as VocabRow[], companyId),
    settings: ((settingsRes.data as { body?: TemplateSettings } | null)?.body ?? {}) as TemplateSettings,
    today: todayIso(),
  };
}
