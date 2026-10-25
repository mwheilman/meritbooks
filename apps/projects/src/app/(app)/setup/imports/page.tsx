import type { Metadata } from 'next';
import Link from 'next/link';
import { InlineNotice, Page, PageHead } from '@meritbooks/merit-ui';
import { booksUrl, pageScope } from '@/lib/scope';
import { getAccess } from '@/lib/access';
import { can } from '@/lib/access/can';
import { ImportsWorkspace } from '@/components/imports/ImportsWorkspace';

export const metadata: Metadata = { title: 'Imports' };
export const dynamic = 'force-dynamic';

/** /setup/imports — bring records in from the tools a company used before (PLT-67/68) and hand opening balances to Books (PLT-70). */
export default async function ImportsPage({ searchParams }: { searchParams: { company?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  const access = await getAccess();
  const companies = scope.installedCompanies.filter((c) => can(access, 'projects.settings', 'configure', c.id));
  const company = companies.find((c) => c.id === searchParams.company) ?? (scope.company && companies.find((c) => c.id === scope.company!.id)) ?? companies[0] ?? null;
  return (
    <Page>
      <PageHead eyebrow={['Settings', 'Imports']} title="Bring records in">
        <p className="ob-lede">From Buildertrend, JobTread, CoConstruct, ServiceTitan, FieldEdge, simPRO, Housecall Pro, Jobber, c-Systems, Procore, QuickBooks or any spreadsheet.</p>
      </PageHead>
      {!company ? (
        <InlineNotice tone="warn" title="Imports need the settings permission at a company.">Ask an owner to bring records in, or to give you Projects settings for your company.</InlineNotice>
      ) : (
        <>
          {companies.length > 1 && (
            <nav className="imp-head-row" aria-label="Company">
              {companies.map((c) => c.id === company.id ? <b key={c.id}>{c.name}</b> : <Link key={c.id} className="link" href={`/setup/imports?company=${c.id}`}>{c.name}</Link>)}
            </nav>
          )}
          <ImportsWorkspace companyId={company.id} companyName={company.name} booksUrl={booksUrl()} />
        </>
      )}
    </Page>
  );
}
