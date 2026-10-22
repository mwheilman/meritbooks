import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { scopedJobs } from '@/lib/pm/scoped';
import { addDays, todayIso } from '@/lib/time';
import { listBillingQueue, listSettledBilling, listSettledDeposits } from '@/lib/pm/money/queries';
import { billingBand } from '@/lib/pm/money/summaries';
import { billingKindLabel } from '@/lib/pm/money/status';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { BillingQueue, type BillingQueueRowView } from '@/components/money/BillingQueue';
import { guardPage } from '@/components/shell/page-guard';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Billing' };
  return { title: (await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds)).billing };
}

/** Company billing: v_billing_queue (draft, ready, sent, rejected) plus the last 90 days issued or approved here. */
export default async function BillingPage() {
  const scope = await pageScope();
  if (!scope) return null;
  await guardPage('/billing');
  const db = await requireDb();
  const since = `${addDays(todayIso(), -90)}T00:00:00Z`;
  const [vocab, jobs, queue, settled, deposits] = await Promise.all([
    getVocabulary(db, scope.company?.id ?? null, scope.companyIds),
    scopedJobs(db, scope),
    listBillingQueue(db, scope.companyIds),
    listSettledBilling(db, scope.companyIds, since),
    listSettledDeposits(db, scope.companyIds, since),
  ]);
  const label = (jobId: string, number: string | null, name: string | null) => jobs.label(jobId) ?? ([number, name].filter(Boolean).join(' · ') || 'Job');
  const rows: BillingQueueRowView[] = [
    ...queue.flatMap((q): BillingQueueRowView[] => {
      const band = billingBand(q);
      if (!band) return [];
      return [{
        id: q.id, kind: q.kind, band, jobId: q.job_id, jobLabel: label(q.job_id, q.job_number, q.job_name), company: jobs.company(q.job_id), customer: q.customer_name,
        label: billingKindLabel(q), status: q.status, suppressed: null, date: q.period_end ?? q.occurred_on, gross: q.gross_earned_cents, retainage: q.retainage_cents,
        net: q.net_cents, invoice: null, error: q.error_text, failing: q.failing_preconditions ?? [], createdBy: q.created_by, ageDays: q.age_days,
      }];
    }),
    ...settled.filter((r) => jobs.byId.has(r.job_id)).map((r): BillingQueueRowView => ({
      id: r.id, kind: 'BILLING', band: r.status === 'ISSUED' ? 'issued' : 'unissued', jobId: r.job_id, jobLabel: label(r.job_id, null, null), company: jobs.company(r.job_id),
      customer: jobs.byId.get(r.job_id)?.customer_name ?? null, label: billingKindLabel(r), status: r.status, suppressed: r.suppressed_reason, date: r.period_end ?? r.occurred_on,
      gross: r.gross_earned_cents, retainage: r.retainage_cents, net: r.net_cents, invoice: r.invoice_number, error: null, failing: [], createdBy: r.created_by, ageDays: null,
    })),
    ...deposits.filter((d) => jobs.byId.has(d.job_id)).map((d): BillingQueueRowView => ({
      id: d.id, kind: 'DEPOSIT', band: d.status === 'ISSUED' ? 'issued' : 'unissued', jobId: d.job_id, jobLabel: label(d.job_id, null, null), company: jobs.company(d.job_id),
      customer: jobs.byId.get(d.job_id)?.customer_name ?? null, label: 'Deposit', status: d.status, suppressed: d.suppressed_reason, date: d.occurred_on,
      gross: d.amount_cents, retainage: 0, net: d.amount_cents, invoice: d.invoice_number, error: null, failing: [], createdBy: d.created_by, ageDays: null,
    })),
  ];
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  const ready = rows.filter((r) => r.band === 'ready');
  const waiting = rows.filter((r) => r.band === 'sent');
  const rejected = rows.filter((r) => r.band === 'rejected');
  return (
    <>
      <PageCrumbs items={[{ label: vocab.billing }]} />
      <PageLine
        facts={[
          where,
          { label: `${count(ready.length)} ready to send · ${money(ready.reduce((s, r) => s + r.net, 0), { decimals: 0 })}`, strong: true, tnum: true },
          `${count(waiting.length)} waiting on Merit Books`,
          ...(rejected.length ? [{ label: `${count(rejected.length)} rejected`, strong: true }] : []),
        ]}
        actions={<span className="t-cap">Merit Books numbers and posts every invoice</span>}
      />
      <Page>
        <PageHead eyebrow={where} title={vocab.billing} />
        <BillingQueue rows={rows} currentUserId={scope.userId} booksPresent={scope.tenant.booksPresent} showCompany={scope.companyIds.length > 1} />
      </Page>
    </>
  );
}
