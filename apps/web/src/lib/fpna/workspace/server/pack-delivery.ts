/**
 * Scheduled pack delivery → FP&A dashboard attachments (AC-W11). SERVER ONLY.
 *
 * For each dashboard added to a pack: recompute it for the LAST COMPLETE month with NO user
 * (governance treats the reader as non-finance — released months only, fail closed), through
 * the per-org RLS-scoped client, and render the same PDF as Export. Tolerates a database
 * without migration 191 (no `fpna_items` column → no attachments). The view / PDF modules are
 * loaded only when a pack actually carries dashboards, so the pack runner's own import graph
 * stays as it was.
 *
 * Security review H3: a dashboard renders only when its companies sit inside the pack's
 * (`itemWithinPack` — an all-companies pack takes any; a dashboard for "all companies" needs an
 * all-companies pack). Anything else is skipped and named in the run status, never emailed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { parsePackItems } from '../pack-items';
import { itemWithinPack } from '@/lib/reports/compiler/pack-scope';

export interface PackAttachment {
  filename: string;
  content: Uint8Array;
  contentType: 'application/pdf';
}

export async function packDashboardAttachments(admin: SupabaseClient, scoped: SupabaseClient, pack: { id: string; org_id: string }, today: string): Promise<{ attachments: PackAttachment[]; problems: string[] }> {
  const { data, error } = await admin.from('report_packs').select('fpna_items, location_ids').eq('id', pack.id).eq('org_id', pack.org_id).maybeSingle();
  if (error || !data) return { attachments: [], problems: [] };
  const all = parsePackItems((data as { fpna_items?: unknown }).fpna_items);
  if (all.length === 0) return { attachments: [], problems: [] };
  const packLocations = (data as { location_ids?: unknown }).location_ids;
  const problems: string[] = [];
  const items = all.filter((item) => {
    if (itemWithinPack(item.companies, packLocations)) return true;
    console.warn('[report-pack delivery] dashboard skipped (outside the pack companies)', pack.id, item.id);
    problems.push(`${item.name}: skipped — it covers companies outside this pack`);
    return false;
  });
  if (items.length === 0) return { attachments: [], problems };

  const [{ createElement }, { renderToBuffer }, { buildExportFilename }, { itemDashboard }, { viewQuerySchema }, { prepare }, { scopeLabelOf, WorkspacePdf }, { buildView }] = await Promise.all([
    import('react'),
    import('@react-pdf/renderer'),
    import('@/lib/reports/export/statement-model'),
    import('../pack-items'),
    import('../query'),
    import('./load'),
    import('./pdf'),
    import('./views'),
  ]);
  const attachments: PackAttachment[] = [];
  for (const item of items) {
    try {
      const p = await prepare({ supabase: scoped, orgId: pack.org_id, userId: null, service: admin, today });
      const q = viewQuerySchema.parse({ tab: 'dashboard', companies: item.companies.join(','), weighting: item.weighting });
      const view = await buildView(p, q, { dashboard: itemDashboard(item), skipCache: true });
      const doc = createElement(WorkspacePdf, { view, scopeLabel: scopeLabelOf(view), generatedFor: 'Scheduled pack' }) as Parameters<typeof renderToBuffer>[0];
      const pdf = await renderToBuffer(doc);
      attachments.push({ filename: buildExportFilename(`fpna-${item.name}-${view.period.label}`, 'pdf'), content: new Uint8Array(pdf), contentType: 'application/pdf' });
    } catch (e) {
      problems.push(`${item.name}: ${e instanceof Error ? e.message : 'could not be rendered'}`);
    }
  }
  return { attachments, problems };
}
