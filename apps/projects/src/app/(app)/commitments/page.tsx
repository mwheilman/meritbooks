import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { lower } from '@/lib/pm/vocab';
import { scopedCommitments } from '@/lib/pm/money/scoped';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { CommitmentQueue } from '@/components/money/CommitmentQueue';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Commitments' };
  return { title: (await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds)).commitments };
}

/** Every purchase order and subcontract in scope, with committed / received / billed / open from v_commitment_status. */
export default async function CommitmentsPage() {
  const scope = await pageScope();
  if (!scope) return null;
  const db = await requireDb();
  const [vocab, rows] = await Promise.all([getVocabulary(db, scope.company?.id ?? null, scope.companyIds), scopedCommitments(db, scope)]);
  const open = rows.filter((r) => r.status === 'APPROVED' || r.status === 'EXECUTED');
  const drafts = rows.filter((r) => r.status === 'DRAFT');
  const held = open.filter((r) => r.t.holdEffective);
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  return (
    <>
      <PageCrumbs items={[{ label: vocab.commitments }]} />
      <PageLine facts={[
        where,
        { label: `${money(open.reduce((s, r) => s + r.t.open, 0), { decimals: 0 })} open on ${count(open.length)} ${lower(vocab.commitments)}`, strong: true, tnum: true },
        `${count(drafts.length)} to approve`,
        ...(held.length ? [{ label: `${count(held.length)} on payment hold`, strong: true }] : []),
      ]} />
      <Page>
        <PageHead eyebrow={where} title={vocab.commitments}>
          <p className="t-cap" style={{ marginTop: 4 }}>Create a {lower(vocab.commitment)} from its job’s {vocab.commitments} tab. Merit Books matches the vendor’s bills to it.</p>
        </PageHead>
        <CommitmentQueue rows={rows} currentUserId={scope.userId} showCompany={scope.companyIds.length > 1} />
      </Page>
    </>
  );
}
