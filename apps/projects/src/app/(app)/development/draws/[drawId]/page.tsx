import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { DrawView } from '@/components/development/DrawView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Lender draw' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Invoices in, the pre-submission check, lien waivers, and the package in the lender's order. */
export default async function LenderDrawPage({ params }: { params: { drawId: string } }) {
  if (!UUID.test(params.drawId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/development');
  const allowed = can(access, 'projects.financials', 'view', o.scope.company?.id ?? null);
  const vres = await o.db.schema('pm').from('v_core_vendors_masked').select('id, name, display_name').eq('is_active', true).order('name').limit(500);
  const vendors = ((vres.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((v) => ({ id: v.id, name: v.display_name || v.name }));
  return (
    <>
      <PageLine facts={[o.where, { label: 'Lender draw', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Lender draw" actions={<ButtonLink variant="quiet" href="/development">Development</ButtonLink>} />
        {!allowed ? <Denied what="Lender draw" /> : <><DrawView drawId={params.drawId} today={todayIso()} vendors={vendors} /></>}
      </Page>
    </>
  );
}
