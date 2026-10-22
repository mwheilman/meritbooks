import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { scopedChangeOrders } from '@/lib/pm/scoped';
import { lower } from '@/lib/pm/vocab';
import { PageLine } from '@/components/common/PageLine';
import { ChangeOrderQueue } from '@/components/co/ChangeOrderQueue';
import { guardPage } from '@/components/shell/page-guard';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Change orders' };
  return { title: (await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds)).change_orders };
}

export default async function ChangeOrdersPage() {
  const scope = await pageScope();
  if (!scope) return null;
  const { money: mv } = await guardPage('/change-orders');
  const db = await requireDb();
  const [rows, vocab] = await Promise.all([scopedChangeOrders(db, scope, false), getVocabulary(db, scope.company?.id ?? null, scope.companyIds)]);
  const approved = rows.filter((r) => r.stage === 'APPROVED').reduce((s, r) => s + r.amount_cents, 0);
  const open = rows.filter((r) => r.stage === 'PCO' || r.stage === 'COR');
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  return (
    <>
      <PageLine facts={[where, { label: `${count(open.length)} open`, strong: true }, ...(mv.contract ? [{ label: `${money(approved)} approved into contracts`, tnum: true }] : [])]} />
      <Page>
        <PageHead eyebrow={where} title={vocab.change_orders}>
          <p className="t-cap" style={{ marginTop: 4 }}>Create a {lower(vocab.change_order)} from its job’s {vocab.change_orders} tab.</p>
        </PageHead>
        <ChangeOrderQueue aria-label={`All ${lower(vocab.change_orders)}`} rows={rows} showJob currentUserId={scope.userId} mode="all" />
      </Page>
    </>
  );
}
