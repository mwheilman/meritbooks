import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { loadCustomers, loadProposals } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { TradeProposalsView } from '@/components/commercial/TradeProposalsView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Trade proposals' };

/** Sub → GC trade proposals (CGC-25); an accepted one creates the job. */
export default async function TradeProposalsPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/trade-proposals');
  const [proposals, customers, types] = await Promise.all([
    loadProposals(o.db, o.companyIds),
    loadCustomers(o.db, o.companyIds),
    o.companyIds.length ? o.db.schema('pm').from('job_types').select('location_id, key, label').in('location_id', o.companyIds).eq('is_active', true).order('sort') : Promise.resolve({ data: [], error: null }),
  ]);
  const company = o.scope.company?.id ?? null;
  const jobTypes = ((types.data ?? []) as Array<{ location_id: string; key: string; label: string }>).map((t) => ({ companyId: t.location_id, key: t.key, label: t.label }));
  const open = proposals.filter((p) => p.status === 'SENT').length;
  return (
    <>
      <PageCrumbs items={[{ label: 'Trade proposals' }]} />
      <PageLine facts={[o.where, { label: `${count(open)} with GCs`, strong: true }, `${count(proposals.filter((p) => p.status === 'DRAFT').length)} drafts`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Trade proposals" />
        <TradeProposalsView proposals={proposals} customers={customers} companies={o.companies} jobTypes={jobTypes} today={todayIso()}
          canEdit={holds(access, 'projects.estimates:edit', company)} canAccept={holds(access, 'projects.jobs:create', company)} />
      </Page>
    </>
  );
}
