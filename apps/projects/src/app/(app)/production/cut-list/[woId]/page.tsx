import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { PageLine } from '@/components/common/PageLine';
import { CutListView } from '@/components/manufacturing/completion/Engineering';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Cut list' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One production order's cut list (edges, sizes, sheets at the nest yield) and its paperless traveler. */
export default async function CutListPage({ params }: { params: { woId: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/production');
  if (!UUID.test(params.woId)) notFound();
  const r = await o.db.schema('pm').from('work_orders').select('id, number, summary, kind').eq('id', params.woId).maybeSingle();
  const wo = r.data as { id: string; number: string; summary: string; kind: string } | null;
  if (!wo || wo.kind !== 'PRODUCTION') notFound();
  return (
    <>
      <PageLine facts={[o.where, { label: wo.number, strong: true }, 'Cut list']} />
      <Page>
        <PageHead eyebrow={wo.number} title={wo.summary} actions={<><ButtonLink variant="quiet" href={`/production/release/${wo.id}`}>Release checks</ButtonLink><ButtonLink variant="quiet" href={`/production?wo=${wo.id}`}>Production</ButtonLink></>} />
        <CutListView woId={wo.id} families={['BASE', 'WALL', 'TALL']} />
      </Page>
    </>
  );
}
