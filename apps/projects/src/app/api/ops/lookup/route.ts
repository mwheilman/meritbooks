export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { cleanSearch, rows } from '@/lib/pm/db';
import { searchCustomers } from '@/lib/pm/people';
import { ASSET_COLS, type AssetRow, type LookupItem, type PriceBookRow } from '@/lib/pm/ops/types';

const Query = z.object({
  kind: z.enum(['jobs', 'assets', 'price_book', 'employees', 'vendors', 'customers']),
  q: z.string().max(80).default(''),
  companyId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
});

/** Type-ahead for the ops forms. RLS client only; every result is the caller's org. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: 'price_book', query: Query }, async ({ db, query, tenant }) => {
  const term = cleanSearch(query.q);
  const companies = new Set(tenant.companies.map((c) => c.id));
  const pm = db.schema('pm');
  let items: LookupItem[] = [];

  if (query.kind === 'jobs') {
    let q = pm.from('v_project_list').select('job_id, location_id, job_number, name, customer_id, customer_name, stage_label, stage_is_terminal').not('stage_is_terminal', 'is', true);
    if (query.companyId) q = q.eq('location_id', query.companyId);
    if (term) q = q.or(`name.ilike.*${term}*,job_number.ilike.*${term}*,customer_name.ilike.*${term}*`);
    const list = rows<{ job_id: string; location_id: string; job_number: string | null; name: string; customer_id: string | null; customer_name: string | null; stage_label: string | null }>(
      await q.order('updated_at', { ascending: false }).limit(12),
      'jobs',
    );
    items = list.filter((j) => companies.has(j.location_id)).map((j) => ({
      id: j.job_id, label: [j.job_number, j.name].filter(Boolean).join(' · '), sub: [j.customer_name, j.stage_label].filter(Boolean).join(' · ') || null,
      companyId: j.location_id, customerId: j.customer_id, customerName: j.customer_name,
    }));
  } else if (query.kind === 'assets') {
    let q = pm.from('assets').select(ASSET_COLS).eq('status', 'ACTIVE');
    if (query.companyId) q = q.eq('location_id', query.companyId);
    if (query.customerId) q = q.eq('customer_id', query.customerId);
    if (term) q = q.or(`serial_number.ilike.*${term}*,make.ilike.*${term}*,model.ilike.*${term}*,site_label.ilike.*${term}*`);
    const list = rows<AssetRow>(await q.order('last_service_on', { ascending: false, nullsFirst: false }).limit(12), 'assets');
    items = list.map((a) => ({
      id: a.id, label: [a.make, a.model].filter(Boolean).join(' ') || a.description || 'Equipment',
      sub: [a.serial_number ? `Serial ${a.serial_number}` : null, a.site_label].filter(Boolean).join(' · ') || null,
      companyId: a.location_id, customerId: a.customer_id,
    }));
  } else if (query.kind === 'price_book') {
    let q = pm.from('v_price_book_items_masked').select('id, location_id, code, name, unit, price_cents, cost_cents, labor_minutes, is_active').eq('is_active', true);
    if (query.companyId) q = q.eq('location_id', query.companyId);
    if (term) q = q.or(`name.ilike.*${term}*,code.ilike.*${term}*`);
    const list = rows<PriceBookRow>(await q.order('code').limit(15), 'price book');
    items = list.map((p) => ({ id: p.id, label: p.name, sub: p.code, companyId: p.location_id, priceCents: p.price_cents, unit: p.unit, laborMinutes: p.labor_minutes }));
  } else if (query.kind === 'employees') {
    let q = db.schema('core').from('employees').select('id, first_name, last_name, title').eq('is_active', true);
    if (term) q = q.or(`first_name.ilike.*${term}*,last_name.ilike.*${term}*`);
    const list = rows<{ id: string; first_name: string; last_name: string; title: string | null }>(await q.order('first_name').limit(12), 'employees');
    items = list.map((e) => ({ id: e.id, label: `${e.first_name} ${e.last_name}`.trim(), sub: e.title, companyId: null }));
  } else if (query.kind === 'customers') {
    const list = await searchCustomers(db, query.q, query.companyId ?? null, 12);
    items = list.map((c) => ({ id: c.id, label: c.display_name || c.name, sub: null, companyId: c.location_id }));
  } else {
    let q = db.schema('pm').from('v_core_vendors_masked').select('id, name, display_name').eq('is_active', true);
    if (term) q = q.or(`name.ilike.*${term}*,display_name.ilike.*${term}*`);
    const list = rows<{ id: string; name: string; display_name: string | null }>(await q.order('name').limit(12), 'vendors');
    items = list.map((v) => ({ id: v.id, label: v.display_name || v.name, sub: null, companyId: null }));
  }
  return { items };
});
