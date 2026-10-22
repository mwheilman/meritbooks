import type { Metadata } from 'next';
import { ButtonLink, KV, Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { guardPage } from '@/components/shell/page-guard';
import { PageLine } from '@/components/common/PageLine';
import { SignOut } from '@/components/shell/SignOut';

export const metadata: Metadata = { title: 'Me' };
export const dynamic = 'force-dynamic';

const SEES: Readonly<Record<1 | 2 | 3 | 4, string>> = {
  1: 'Your own jobs, tasks and hours. No contract, cost or pay amounts.',
  2: 'Your jobs with hours and quantities. No dollar amounts.',
  3: 'Contract and cost amounts on the jobs you run. Not individual pay rates.',
  4: 'Every job and all money, including pay rates.',
};

/** "Me" (Labor rail): who you are here, where you work, and what your role lets you see. */
export default async function MePage() {
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/me');
  const db = await requireDb();
  const { data } = await db.schema('core').from('users').select('first_name, last_name, email').eq('clerk_user_id', scope.userId).maybeSingle();
  const me = data as { first_name: string | null; last_name: string | null; email: string | null } | null;
  const name = [me?.first_name, me?.last_name].filter(Boolean).join(' ') || 'You';
  const names = new Map(scope.tenant.companies.map((c) => [c.id, c.name]));
  const companies = Object.keys(access.byCompany).map((id) => names.get(id)).filter((n): n is string => !!n);
  return (
    <>
      <PageLine facts={[{ label: name, strong: true }, access.title]} />
      <Page>
        <PageHead eyebrow={scope.tenant.orgName ?? 'Workspace'} title="Me" />
        <div className="surface stack" style={{ maxWidth: 640, padding: 16 }}>
          <KV
            items={[
              { term: 'Name', value: name },
              ...(me?.email ? [{ term: 'Email', value: me.email }] : []),
              { term: 'Role', value: access.title },
              { term: companies.length === 1 ? 'Company' : `Companies (${count(companies.length)})`, value: companies.join(', ') || 'None yet' },
              { term: 'You see', value: SEES[access.moneyLevel] },
            ]}
          />
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <ButtonLink href="/time">My hours</ButtonLink>
            <SignOut />
          </div>
          <p className="t-cap">Your role and companies are set by your office in Merit Books. Ask them if something here looks wrong.</p>
        </div>
      </Page>
    </>
  );
}
