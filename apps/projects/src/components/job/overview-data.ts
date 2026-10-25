import 'server-only';
/**
 * Cheap reads the job page header, rail and Overview share (RLS client; each read fails soft to
 * "unknown" so one missing table never blanks the page).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { pm } from '@/lib/pm/db';
import type { ModuleKey } from '@/lib/packs';

export interface OpenCounts {
  workOrders: number | null;
  selections: number | null;
  draftBilling: number | null;
  draftCommitments: number | null;
}

async function headCount(q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try {
    const r = await q;
    return r.error ? null : r.count ?? 0;
  } catch {
    return null;
  }
}

export async function loadOpenCounts(db: SupabaseClient, jobId: string, modules: ReadonlySet<ModuleKey>): Promise<OpenCounts> {
  const [workOrders, selections, draftBilling, draftCommitments] = await Promise.all([
    modules.has('dispatch') || modules.has('production')
      ? headCount(pm(db).from('work_orders').select('id', { count: 'exact', head: true }).eq('job_id', jobId).not('status', 'in', '(COMPLETE,CLOSED,CANCELLED)'))
      : Promise.resolve(null),
    modules.has('selections')
      ? headCount(pm(db).from('selections').select('id', { count: 'exact', head: true }).eq('job_id', jobId).in('status', ['OPEN', 'PROPOSED']))
      : Promise.resolve(null),
    modules.has('billing') || modules.has('retainage')
      ? headCount(pm(db).from('billing_requests').select('id', { count: 'exact', head: true }).eq('job_id', jobId).in('status', ['DRAFT', 'REJECTED']))
      : Promise.resolve(null),
    modules.has('commitments')
      ? headCount(pm(db).from('commitments').select('id', { count: 'exact', head: true }).eq('job_id', jobId).eq('status', 'DRAFT'))
      : Promise.resolve(null),
  ]);
  return { workOrders, selections, draftBilling, draftCommitments };
}

export interface JobSite {
  label: string;
  mapHref: string | null;
}

/** The job's site address (pm.projects site_* until jobs carry core.sites ids). */
export async function loadJobSite(db: SupabaseClient, jobId: string): Promise<JobSite | null> {
  try {
    const r = await pm(db).from('projects').select('site_address_line1, site_city, site_state, site_zip, site_lat, site_lng').eq('job_id', jobId).maybeSingle();
    if (r.error || !r.data) return null;
    const d = r.data as { site_address_line1: string | null; site_city: string | null; site_state: string | null; site_zip: string | null; site_lat: number | null; site_lng: number | null };
    const parts = [d.site_address_line1, [d.site_city, d.site_state].filter(Boolean).join(', '), d.site_zip].filter((x) => !!x && String(x).trim());
    if (!parts.length) return null;
    const label = parts.join(' · ');
    const q = d.site_lat != null && d.site_lng != null ? `${d.site_lat},${d.site_lng}` : parts.join(' ');
    return { label, mapHref: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` };
  } catch {
    return null;
  }
}

export interface JobPhoto {
  id: string;
  name: string;
  url: string | null;
  at: string;
}

/** Latest photos linked to the job (pm.document_links → public.documents images). */
export async function loadJobPhotos(db: SupabaseClient, jobId: string, limit = 6): Promise<JobPhoto[] | null> {
  try {
    const links = await pm(db).from('document_links').select('document_id, created_at').eq('job_id', jobId).order('created_at', { ascending: false }).limit(40);
    if (links.error) return null;
    const ids = [...new Set(((links.data ?? []) as Array<{ document_id: string }>).map((l) => l.document_id))];
    if (!ids.length) return [];
    const docs = await db.from('documents').select('id, file_name, storage_path, mime_type, created_at').in('id', ids).like('mime_type', 'image/%').order('created_at', { ascending: false }).limit(limit);
    if (docs.error) return null;
    const rows = (docs.data ?? []) as Array<{ id: string; file_name: string; storage_path: string; mime_type: string | null; created_at: string }>;
    if (!rows.length) return [];
    const signed = await db.storage.from('documents').createSignedUrls(rows.map((r) => r.storage_path), 600).catch(() => null);
    const urls = new Map<string, string>();
    for (const s of signed?.data ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
    return rows.map((r) => ({ id: r.id, name: r.file_name, url: urls.get(r.storage_path) ?? null, at: r.created_at }));
  } catch {
    return null;
  }
}

export interface RailContactRow {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  primary: boolean;
}

/** The customer's active contacts (core.contacts through RLS), primary first. */
export async function loadCustomerContacts(db: SupabaseClient, customerId: string | null): Promise<RailContactRow[] | null> {
  if (!customerId) return [];
  try {
    const r = await db.schema('core').from('contacts').select('id, first_name, last_name, email, phone, title, is_primary')
      .eq('customer_id', customerId).eq('identity_status', 'active').order('is_primary', { ascending: false }).limit(6);
    if (r.error) return null;
    return ((r.data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; title: string | null; is_primary: boolean }>).map((c) => ({
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Contact',
      title: c.title, email: c.email, phone: c.phone, primary: c.is_primary,
    }));
  } catch {
    return null;
  }
}
