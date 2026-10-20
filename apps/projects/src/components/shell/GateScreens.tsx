import { OrganizationList } from '@clerk/nextjs';
import { ButtonLink, Eyebrow, Lockup } from '@meritbooks/merit-ui';

/** Signed in, but no workspace resolves: pick one or create one. */
export function NoWorkspaceScreen() {
  return (
    <main className="mp-gate">
      <div className="mp-gate-card">
        <Lockup module="projects" variant="full-color" height={32} />
        <div>
          <Eyebrow>Workspace</Eyebrow>
          <h1 className="t-title">Choose a workspace</h1>
          <p style={{ marginTop: 8 }}>
            Merit Projects works inside a workspace your team shares with Merit Books. Pick the one you work in, or
            create one for your company.
          </p>
        </div>
        <OrganizationList
          hidePersonal
          afterSelectOrganizationUrl="/"
          afterCreateOrganizationUrl="/onboarding"
        />
      </div>
    </main>
  );
}

/** The org resolved, but Merit Projects is not turned on for it. */
export function EnableProjectsScreen({ orgName, booksUrl }: { orgName: string | null; booksUrl: string }) {
  return (
    <main className="mp-gate">
      <div className="mp-gate-card">
        <Lockup module="projects" variant="full-color" height={32} />
        <div>
          <Eyebrow>{orgName ?? 'Your workspace'}</Eyebrow>
          <h1 className="t-title">Enable Merit Projects</h1>
        </div>
        <p>
          Merit Projects runs your jobs: stages, budgets by cost code, schedules and change orders. Contract value,
          budget and progress flow to Merit Books on their own, so job cost ties to the ledger and nothing is entered
          twice.
        </p>
        <p>
          {orgName ?? 'This workspace'} does not have Merit Projects turned on yet. An owner or admin turns it on in
          Merit Books settings; then come back here and we will set up your first company in about three minutes.
        </p>
        <div className="btn-row">
          <ButtonLink variant="primary" href={`${booksUrl}/settings`}>
            Open Merit Books settings
          </ButtonLink>
          <ButtonLink variant="quiet" href="/">
            I turned it on, check again
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
