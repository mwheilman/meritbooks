import { currentUser } from '@clerk/nextjs/server';
import { BooksShell } from '@/components/layout/books-shell';
import { AppProviders } from './providers';
import { readInitialCompany } from '@/lib/company-scope-server';
import { isSpecificCompany } from '@/lib/company-scope';
import { getShellClientContext } from '@/lib/shell/actions';
import { ShellSeedProvider, type ShellSeed } from '@/lib/shell/seed';

/** Display-only values the shell can paint before its client reads answer. Never throws. */
async function readShellSeed(companyId: string): Promise<ShellSeed> {
  const [user, clientContext] = await Promise.all([
    currentUser().catch(() => null),
    isSpecificCompany(companyId) ? getShellClientContext(companyId).catch(() => null) : Promise.resolve(null),
  ]);
  const name = user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.primaryEmailAddress?.emailAddress || null : null;
  return { userName: name, clientContext };
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read the active company on the server so the shell's first client render
  // matches the server HTML (no hydration mismatch) and the context chip names the
  // right client on first paint. The seed adds the user's name and the client's
  // period status so the rail footer and chip don't flash placeholder values.
  const initialCompany = await readInitialCompany();
  const seed = await readShellSeed(initialCompany.id);
  return (
    <AppProviders initialCompany={initialCompany}>
      <ShellSeedProvider seed={seed}>
        {/* merit-ui shell: rail · bar (⌘J chip, crumbs, ⌘K, ⌘/) · context line · page.
            Toasts, the CPA Desk command bar, search and help are mounted inside it. */}
        <BooksShell>{children}</BooksShell>
      </ShellSeedProvider>
    </AppProviders>
  );
}
