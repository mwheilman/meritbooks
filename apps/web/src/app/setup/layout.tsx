import { Lockup } from '@meritbooks/merit-ui';

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-950 flex flex-col">
      <header className="border-b border-slate-800/50 px-6 py-4">
        {/* The product lockup file (kit rule 10), full colour on the light page. */}
        <Lockup module="books" variant="full-color" height={28} />
      </header>
      <main className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-lg">{children}</div>
      </main>
    </div>
  );
}
