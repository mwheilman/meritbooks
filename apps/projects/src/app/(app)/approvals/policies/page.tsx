import type { Metadata } from 'next';
import Link from 'next/link';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { loadExceptions, loadPolicy } from '@/lib/approvals/server';
import type { ExceptionRow } from '@/lib/approvals/types';
import { PageLine } from '@/components/common/PageLine';
import { PolicyView } from '@/components/approvals/PolicyView';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { holds } from '@/lib/nav';
import '@/components/approvals/approvals.css';

export const metadata: Metadata = { title: 'Approval rules' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Approval rules (BP-26/27): who approves what, by amount, seeded from the company's size. */
export default async function ApprovalPoliciesPage({ searchParams }: { searchParams: { company?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/settings');
  const db = await requireDb();
  const pick = searchParams.company && UUID.test(searchParams.company) ? scope.installedCompanies.find((c) => c.id === searchParams.company) : null;
  const company = scope.company ?? pick ?? scope.installedCompanies[0] ?? null;
  if (!company) return null;
  const policy = await loadPolicy(db, company.id);
  const seesExceptions = holds(access, 'projects.settings:configure', company.id) || holds(access, 'projects.billing:post', company.id);
  const exceptions: ExceptionRow[] = seesExceptions ? await loadExceptions(db, company.id, null, null) : [];
  return (
    <>
      <PageCrumbs items={[{ label: 'Approvals', href: '/approvals' }, { label: 'Approval rules' }]} />
      <PageLine facts={[company.name, { label: `${count(policy.rules.filter((r) => r.is_active).length)} active rules`, strong: true }, `${count(policy.people)} people`, ...(exceptions.length ? [`${count(exceptions.length)} self-approvals on the report`] : [])]} />
      <Page>
        <PageHead eyebrow={['Approvals', company.name]} title="Approval rules" />
        {!scope.company && scope.installedCompanies.length > 1 && (
          <p className="t-cap" style={{ marginBottom: 16 }}>
            Company:{' '}
            {scope.installedCompanies.map((c, i) => (
              <span key={c.id}>{i > 0 ? ' · ' : ''}{c.id === company.id ? <b>{c.name}</b> : <Link className="link" href={`/approvals/policies?company=${c.id}`}>{c.name}</Link>}</span>
            ))}
          </p>
        )}
        <PolicyView key={company.id} policy={policy} exceptions={exceptions} showExceptions={seesExceptions} readOnly={scope.readOnly} />
      </Page>
    </>
  );
}
