import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getModulesFor, getVocabulary } from '@/lib/pm/config';
import { scopedChangeOrders, scopedJobs } from '@/lib/pm/scoped';
import { lower } from '@/lib/pm/vocab';
import { scopedCommitments } from '@/lib/pm/money/scoped';
import { listBillingQueue } from '@/lib/pm/money/queries';
import { billingBand } from '@/lib/pm/money/summaries';
import { billingKindLabel } from '@/lib/pm/money/status';
import { PageLine } from '@/components/common/PageLine';
import { ChangeOrderQueue } from '@/components/co/ChangeOrderQueue';
import { CommitmentQueue } from '@/components/money/CommitmentQueue';
import { BillingQueue, type BillingQueueRowView } from '@/components/money/BillingQueue';
import { ReviewKinds, type ReviewKind } from '@/components/money/ReviewKinds';

export const metadata: Metadata = { title: 'To review' };

const KINDS: ReadonlyArray<ReviewKind> = ['change-orders', 'commitments', 'billing', 'deposits'];

/**
 * To review (S3 queue): change orders, commitments awaiting approval, billing ready to send
 * and deposits Merit Books rejected or has not picked up. One kind is live at a time.
 */
export default async function ReviewPage({ searchParams }: { searchParams: { kind?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  const db = await requireDb();
  const [cos, vocab, modules, drafts, queue, jobs] = await Promise.all([
    scopedChangeOrders(db, scope, true),
    getVocabulary(db, scope.company?.id ?? null, scope.companyIds),
    getModulesFor(db, scope.companyIds, scope.installs),
    scopedCommitments(db, scope, ['DRAFT']),
    listBillingQueue(db, scope.companyIds),
    scopedJobs(db, scope),
  ]);
  const toView = (q: (typeof queue)[number]): BillingQueueRowView | null => {
    const band = billingBand(q);
    if (!band || !jobs.byId.has(q.job_id)) return null;
    return {
      id: q.id, kind: q.kind, band, jobId: q.job_id, jobLabel: jobs.label(q.job_id) ?? ([q.job_number, q.job_name].filter(Boolean).join(' · ') || 'Job'), company: jobs.company(q.job_id),
      customer: q.customer_name, label: billingKindLabel(q), status: q.status, suppressed: null, date: q.period_end ?? q.occurred_on, gross: q.gross_earned_cents,
      retainage: q.retainage_cents, net: q.net_cents, invoice: null, error: q.error_text, failing: q.failing_preconditions ?? [], createdBy: q.created_by, ageDays: q.age_days,
    };
  };
  const billing = queue.filter((q) => q.kind === 'BILLING').map(toView).filter((r): r is BillingQueueRowView => !!r && (r.band === 'ready' || r.band === 'rejected'));
  const blocked = queue.filter((q) => q.kind === 'BILLING' && billingBand(q) === 'draft').length;
  const deposits = queue.filter((q) => q.kind === 'DEPOSIT').map(toView).filter((r): r is BillingQueueRowView => !!r);
  const depRejected = deposits.filter((d) => d.band === 'rejected');

  const showMoney = modules.includes('commitments') || modules.includes('billing') || drafts.length > 0 || queue.length > 0;
  const kind: ReviewKind = KINDS.includes(searchParams.kind as ReviewKind) ? (searchParams.kind as ReviewKind) : 'change-orders';
  const total = cos.reduce((s, r) => s + r.amount_cents, 0);
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  const waiting = cos.length + drafts.length + billing.length + depRejected.length;
  const sum = (xs: ReadonlyArray<{ net: number }>) => money(xs.reduce((s, x) => s + x.net, 0), { decimals: 0 });

  return (
    <>
      <PageLine
        facts={[where, { label: `${count(waiting)} waiting`, strong: true }, { label: `${money(total)} pending contract change`, tnum: true }, ...(billing.length ? [{ label: `${sum(billing)} ready to bill`, tnum: true }] : [])]}
        actions={<span className="t-cap">Nothing joins a contract, a commitment or an invoice until someone other than the preparer approves it</span>}
      />
      <Page>
        <PageHead eyebrow={[{ 'change-orders': lower(vocab.change_orders), commitments: lower(vocab.commitments), billing: 'billing to send', deposits: 'deposits' }[kind], where]} title="To review" />
        {showMoney && (
          <ReviewKinds
            value={kind}
            items={[
              { value: 'change-orders', label: vocab.change_orders, count: count(cos.length), caption: `Potential and requested · ${money(total, { decimals: 0 })}` },
              { value: 'commitments', label: vocab.commitments, count: count(drafts.length), caption: `Drafts to approve · ${money(drafts.reduce((s, d) => s + d.t.committed, 0), { decimals: 0 })}` },
              { value: 'billing', label: 'Billing to send', count: count(billing.length), caption: `${blocked ? `${count(blocked)} more need a fix · ` : ''}${sum(billing)}` },
              { value: 'deposits', label: 'Deposits', count: count(depRejected.length), caption: `${count(deposits.length - depRejected.length)} waiting on Merit Books` },
            ]}
          />
        )}
        {kind === 'change-orders' && <ChangeOrderQueue aria-label={`${vocab.change_orders} waiting for approval`} rows={cos} showJob currentUserId={scope.userId} mode="review" />}
        {kind === 'commitments' && <CommitmentQueue rows={drafts} currentUserId={scope.userId} showCompany={scope.companyIds.length > 1} mode="review" />}
        {kind === 'billing' && <BillingQueue rows={billing} currentUserId={scope.userId} booksPresent={scope.tenant.booksPresent} showCompany={scope.companyIds.length > 1} only={['ready', 'rejected']} label="Billing to send" />}
        {kind === 'deposits' && <BillingQueue rows={deposits} currentUserId={scope.userId} booksPresent={scope.tenant.booksPresent} showCompany={scope.companyIds.length > 1} only={['rejected', 'sent']} label="Deposit requests" />}
      </Page>
    </>
  );
}
