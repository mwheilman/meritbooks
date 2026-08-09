import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { ToastContainer } from '@/components/ui';
import { CommandBar } from '@/components/nl/command-bar';
import { HelpButtonFloating } from '@/components/help/help-button';
import { AppProviders } from './providers';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppProviders>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto p-6">
            {children}
          </main>
        </div>
        <ToastContainer />
        <CommandBar />
        <HelpButtonFloating />
      </div>
    </AppProviders>
  );
}
