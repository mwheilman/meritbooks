import type { Metadata } from 'next';
import { Page, PageHead, money } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadRetainageLedger } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { maskMoney } from '@/lib/access/mask';
import { RetainageLedgerView } from '@/components/commercial/RetainageLedgerView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Retainage ledger' };

const TABS = new Set(['receivable', 'payable', 'by-customer']);

/** Retainage receivable and payable side by side (CGC-49). */
export default async function RetainageLedgerPage({ searchParams }: { searchParams: { tab?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/retainage-ledger');
  const jobs = jobRefs(o);
  const company = o.scope.company?.id ?? null;
  // Server-loaded, so masked here: the receivable side is contract value, the payable side (what we
  // hold from subs) is cost — an office manager without cost sees the receivable side only.
  const data = maskMoney(await loadRetainageLedger(o.db, jobs.map((j) => j.id)), access, company, ['retainage_ledger']);
  const rec = data.both.reduce((s, r) => s + Number(r.receivable_outstanding_cents ?? 0), 0);
  const pay = data.payable.reduce((s, r) => s + Number(r.outstanding_cents ?? 0), 0);
  const tab = searchParams.tab && TABS.has(searchParams.tab) ? (searchParams.tab as 'receivable' | 'payable' | 'by-customer') : 'receivable';
  return (
    <>
      <PageCrumbs items={[{ label: 'Retainage', href: '/retainage' }, { label: 'Ledger' }]} />
      <PageLine facts={[o.where, { label: `${money(rec, { decimals: 0 })} receivable`, strong: true, tnum: true }, { label: `${money(pay, { decimals: 0 })} payable`, tnum: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Retainage ledger" />
        <RetainageLedgerView {...data} jobs={jobs} today={todayIso()} initialTab={tab}
          canBill={holds(access, 'projects.billing:create', company)}
          canRelease={holds(access, 'projects.commitments:approve', company) && holds(access, 'projects.financials:view', company)} />
      </Page>
    </>
  );
}
