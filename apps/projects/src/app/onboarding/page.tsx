import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ButtonLink, InlineNotice, Page, PageHead } from '@meritbooks/merit-ui';
import { getDb, getTenant } from '@/lib/tenant';
import { aiConfigured } from '@/lib/ai/gateway';
import { companyJobTypes, loadOnboardingState, teamMembers } from '@/lib/onboarding/load';
import { OnboardingFlow, type FlowProps } from './_components/flow';

export const dynamic = 'force-dynamic';

function booksBase(): string {
  return (process.env.NEXT_PUBLIC_BOOKS_URL || 'https://meritbooks-web.vercel.app').replace(/\/+$/, '');
}

function Calm({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Page className="ob-page">
      <PageHead eyebrow="Set up" title={title} />
      <InlineNotice title={children} />
      {action && <div className="ob-foot">{action}</div>}
    </Page>
  );
}

export default async function OnboardingPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const tenant = await getTenant();
  if (tenant.state === 'no_session') redirect('/sign-in');
  if (tenant.state === 'no_org') {
    return <Calm title="Pick a workspace first">You&apos;re signed in, but no workspace is open. Choose one in Merit Books, then come back.</Calm>;
  }
  if (tenant.state === 'not_entitled') {
    return (
      <Calm title="Merit Projects isn't on for this workspace" action={<ButtonLink href={`${booksBase()}/settings`}>Open Books settings</ButtonLink>}>
        {tenant.orgName ?? 'This workspace'} doesn&apos;t have Merit Projects yet. An admin can turn it on in Merit Books.
      </Calm>
    );
  }
  if (tenant.companies.length === 0) {
    return (
      <Calm title="Add a company first" action={<ButtonLink href={`${booksBase()}/onboarding`}>Add a company in Books</ButtonLink>}>
        Merit Projects sets up per company, and this workspace has none yet. Add one in Merit Books; it shows up here right away.
      </Calm>
    );
  }

  const db = (await getDb())!;
  const companyParam = typeof searchParams.company === 'string' ? searchParams.company : null;
  const mode = searchParams.mode === 'change' ? 'change' : 'first';
  const state = await loadOnboardingState(db, tenant.companies);
  const company = companyParam ? state.companies.find((c) => c.id === companyParam) ?? null : null;
  if (companyParam && !company) redirect('/onboarding');
  if (mode === 'change' && !company) redirect('/onboarding');

  const anyInstalled = state.companies.some((c) => c.installed);
  const savedSelection = state.orgRun?.inputs.selectedCompanyIds?.filter((id) => state.companies.some((c) => c.id === id)) ?? null;
  // Step 0 only for a first setup of a multi-company workspace (also when the shell sent us
  // straight to one company: that company just starts first).
  const showSelect = mode === 'first' && state.companies.length > 1 && !anyInstalled && !(savedSelection && savedSelection.length > 0);

  let queue: string[];
  if (mode === 'change' && company) queue = [company.id];
  else if (savedSelection && savedSelection.length > 0) queue = savedSelection;
  else if (company) queue = [company.id];
  else queue = state.companies.filter((c) => !c.installed).map((c) => c.id);
  if (company && !queue.includes(company.id)) queue = [company.id, ...queue];
  if (company && queue[0] !== company.id && mode === 'first') queue = [company.id, ...queue.filter((id) => id !== company.id)];

  const pending = queue.filter((id) => {
    const c = state.companies.find((x) => x.id === id);
    return c && (mode === 'change' || !c.installed || c.run?.status === 'APPLIED');
  });
  if (!showSelect && pending.length === 0) {
    return (
      <Calm title="You're set up" action={<><ButtonLink variant="primary" href="/">Go to Home</ButtonLink><Link className="link" href="/settings">Change a company&apos;s setup</Link></>}>
        Every company you picked has its workspace. Change one any time from Settings.
      </Calm>
    );
  }

  const jobTypesByCompany: FlowProps['jobTypesByCompany'] = {};
  await Promise.all(state.companies.filter((c) => c.installed && pending.includes(c.id)).map(async (c) => {
    jobTypesByCompany[c.id] = await companyJobTypes(db, c.id);
  }));
  const team = await teamMembers(db);

  return (
    <OnboardingFlow
      orgName={tenant.orgName ?? 'Your workspace'}
      companies={state.companies}
      tiles={state.tiles}
      mode={mode}
      showSelect={showSelect}
      queue={showSelect ? [] : pending}
      jobTypesByCompany={jobTypesByCompany}
      team={team}
      booksTeamUrl={`${booksBase()}/team`}
      aiConfigured={aiConfigured()}
      problem={state.problem}
    />
  );
}
