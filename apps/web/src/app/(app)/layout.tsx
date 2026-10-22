import { BooksShell } from '@/components/layout/books-shell';
import { AppProviders } from './providers';
import { readInitialCompany } from '@/lib/company-scope-server';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read the active company on the server so the shell's first client render
  // matches the server HTML (no hydration mismatch) and the context chip names the
  // right client on first paint.
  const initialCompany = await readInitialCompany();
  return (
    <AppProviders initialCompany={initialCompany}>
      {/* merit-ui shell: rail · bar (⌘J chip, crumbs, ⌘K, ⌘/) · context line · page.
          Toasts, the CPA Desk command bar, search and help are mounted inside it. */}
      <BooksShell>{children}</BooksShell>
    </AppProviders>
  );
}
