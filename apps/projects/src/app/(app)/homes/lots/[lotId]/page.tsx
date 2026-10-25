import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppLink, Page, PageHead } from '@meritbooks/merit-ui';
import { HttpError } from '@/lib/api-errors';
import { can } from '@/lib/access/can';
import { rows } from '@/lib/pm/db';
import { vendorNames } from '@/lib/pm/ops/scope';
import { houseStage } from '@/lib/residential/labels';
import { loadBuilder, loadLot } from '@/lib/residential/queries';
import { resPage, UUID } from '@/lib/residential/page';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { LotDesk, type LotDeskProps } from '@/components/residential/LotDesk';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lot' };

export default async function LotPage({ params }: { params: { lotId: string } }) {
  if (!UUID.test(params.lotId)) notFound();
  const g = await resPage('/homes', 'projects.jobs', 'view');
  if (!g) return null;
  const { o, access } = g;
  let lot;
  try {
    lot = await loadLot(o.db, params.lotId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const l = lot.lot as Record<string, unknown>;
  const companyId = String(l.location_id);
  const jobId = typeof l.job_id === 'string' ? l.job_id : null;
  const [b, customers, tasks, vendors] = await Promise.all([
    loadBuilder(o.db, [companyId]),
    o.db.schema('pm').from('v_core_customers_masked').select('id, name, display_name').or(`location_id.eq.${companyId},location_id.is.null`).is('deleted_at', null).order('name').limit(500),
    jobId ? o.db.schema('pm').from('tasks').select('title, status, is_summary').eq('job_id', jobId).limit(2000) : Promise.resolve({ data: [], error: null }),
    vendorNames(o.db, lot.packageItems.map((i) => i.vendor_id)),
  ]);
  const board = b.lots.find((x) => x.lot_id === params.lotId);
  const community = b.communities.find((c) => c.id === l.community_id);
  const desk: LotDeskProps['lot'] = {
    id: params.lotId, lot_number: String(l.lot_number), block: (l.block as string | null) ?? null, status: String(l.status), plan_id: (l.plan_id as string | null) ?? null,
    elevation_id: (l.elevation_id as string | null) ?? null, job_id: jobId, premium_cents: Number(l.premium_cents ?? 0), is_spec: l.is_spec === true, current_stage: board?.current_stage ?? null,
  };
  return (
    <>
      <PageLine facts={[o.companyName(companyId) ?? o.where, ...(community ? [{ label: community.name, strong: true }] : []), `Lot ${desk.block ? `${desk.block}-` : ''}${desk.lot_number}`]} />
      <Page>
        <PageHead eyebrow={[<AppLink key="h" href="/homes">Homes</AppLink>, community?.name ?? 'Lot']} title={`Lot ${desk.block ? `${desk.block}-` : ''}${desk.lot_number}${board?.plan_code ? ` · ${board.plan_code}` : ''}`} />
        <LotDesk lot={desk} houseStage={houseStage(rows<{ title: string; status: string; is_summary: boolean }>(tasks as { data: unknown; error: null }, 'tasks'))}
          agreement={lot.agreement} paOptions={lot.paOptions} addenda={lot.addenda} packageItems={lot.packageItems} elevations={lot.elevations}
          plans={b.plans} options={b.options} vendors={vendors}
          customers={customers.error ? [] : ((customers.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((c) => ({ id: c.id, name: c.display_name || c.name }))}
          today={todayIso()} can={{ sell: can(access, 'projects.estimates', 'edit', companyId), release: can(access, 'projects.commitments', 'create', companyId) }} />
      </Page>
    </>
  );
}
