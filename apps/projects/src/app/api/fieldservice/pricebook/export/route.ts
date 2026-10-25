import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { can } from '@/lib/access/can';
import { centsCell, toCsv } from '@/lib/fieldservice/csv';
import { loadPricebook } from '@/lib/fieldservice/queries';
import { Uuid } from '@/lib/pm/ops/schemas';

const Query = z.object({ companyId: Uuid });

/**
 * Excel round trip (FS-46): every item with its formula inputs and prices. Cost columns are
 * included only for callers who hold projects.financials at the company (the DB masks them
 * otherwise, and the column is dropped rather than exported blank).
 */
export const GET = route({ access: { cap: 'projects.settings', action: 'view' }, mask: false, query: Query }, async ({ db, query, tenant, access }) => {
  assertCompany(tenant, query.companyId);
  const book = await loadPricebook(db, query.companyId, 10_000);
  const cost = can(access, 'projects.financials', 'view', query.companyId);
  const cat = new Map(book.categories.map((c) => [c.id, c.code]));
  const bu = new Map(book.businessUnits.map((b) => [b.id, b.code]));
  const code = new Map(book.items.map((i) => [i.id, i.code]));
  const bundle = new Map<string, string[]>();
  for (const b of book.bundles) bundle.set(b.service_item_id, [...(bundle.get(b.service_item_id) ?? []), `${code.get(b.material_item_id) ?? ''}:${b.qty}`]);
  // target_gm_pct is cost-equivalent (cost = price × (1 − gm)), so it follows the cost rule.
  const header = ['code', 'name', 'kind', 'category', 'business_unit', 'unit', 'task_hours', ...(cost ? ['cost'] : []), 'price', 'member_price', 'after_hours_price', 'price_locked', ...(cost ? ['target_gm_pct'] : []), 'materials', 'customer_description', 'active'];
  const rows = book.items.map((i) => [
    i.code, i.name, i.kind, i.category_id ? cat.get(i.category_id) ?? '' : '', i.business_unit_id ? bu.get(i.business_unit_id) ?? '' : '', i.unit,
    i.task_hours ?? '', ...(cost ? [i.kind === 'SERVICE' ? '' : centsCell(i.cost_cents)] : []), centsCell(i.price_cents), centsCell(i.member_price_cents),
    centsCell(i.after_hours_price_cents), i.price_locked ? 'yes' : 'no', ...(cost ? [i.target_gm_pct ?? ''] : []), (bundle.get(i.id) ?? []).join(';'),
    i.customer_description ?? '', i.is_active ? 'yes' : 'no',
  ]);
  const company = tenant.companies.find((c) => c.id === query.companyId)?.name ?? 'company';
  const file = `price-book-${company.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(toCsv(header, rows), {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store' },
  });
});
