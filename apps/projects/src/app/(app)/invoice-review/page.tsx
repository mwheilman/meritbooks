import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import { InvoiceReview } from '@/components/fieldservice/review/InvoiceReview';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { rpcLoad } from '@/lib/fieldservice/completion';
import type { FinancingRecon, ReviewRow } from '@/lib/fieldservice/completion-types';

export const metadata: Metadata = { title: 'Invoice review' };
export const dynamic = 'force-dynamic';

/** Invoice review queue (FS-94), text-to-pay (FS-96) and financing funding (FS-97). */
export default async function InvoiceReviewPage({ searchParams }: { searchParams: { tab?: string } }) {
  const g = await fsPage([['projects.billing', 'view'], ['projects.dispatch', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Invoice review" /><OneCompany what="The invoice review queue" /></Page></>);
  const finOk = g.can('projects.billing', 'view') || g.can('projects.financials', 'view') || g.can('projects.reports', 'view');
  const [reviews, financing] = await Promise.all([
    rpcLoad<ReviewRow[]>(o.db, 'fs_review_queue', { p_location: companyId }, []),
    finOk ? rpcLoad<FinancingRecon | null>(o.db, 'fs_financing_recon', { p_location: companyId, p_as_of: null }, null) : Promise.resolve({ data: null, error: null }),
  ]);
  const company = o.companyName(companyId) ?? o.where;
  const waiting = reviews.data.filter((r) => r.status !== 'APPROVED');
  const blocked = waiting.filter((r) => r.blocking_count > 0).length;
  return (
    <>
      <PageLine facts={[company, { label: `${count(waiting.length)} to review`, strong: true }, ...(blocked ? [`${count(blocked)} must be fixed`] : [])]} />
      <Page>
        <PageHead eyebrow={company} title="Invoice review" />
        <InvoiceReview companyId={companyId} reviews={reviews.data} error={reviews.error} financing={financing.data} financingError={financing.error}
          initialTab={searchParams.tab === 'financing' && finOk ? 'financing' : 'queue'}
          can={{ approve: g.can('projects.billing', 'create'), override: g.can('projects.billing', 'approve'), dispatch: g.can('projects.dispatch', 'edit'), financing: finOk }} />
      </Page>
    </>
  );
}
