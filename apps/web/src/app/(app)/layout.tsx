import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { ToastContainer } from '@/components/ui';
import { CommandBar } from '@/components/nl/command-bar';
import { HelpButtonFloating } from '@/components/help/help-button';
import { ErrorBoundary } from '@/components/error-boundary';
import { AppProviders } from './providers';
import { readInitialCompany } from '@/lib/company-scope-server';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read the active company on the server so the shell's first client render
  // matches the server HTML (no hydration mismatch) and the header names the
  // right company on first paint.
  const initialCompany = await readInitialCompany();
  return (
    <AppProviders initialCompany={initialCompany}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto p-6">
            <ErrorBoundary>{children}</ErrorBoundary>
          </main>
        </div>
        <ToastContainer />
        <CommandBar />
        <HelpButtonFloating />
      </div>
    </AppProviders>
  );
}
