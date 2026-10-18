export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-950 flex flex-col">
      <header className="border-b border-slate-800/50 px-6 py-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/meritbooks-logo-dark.svg" alt="MeritBooks" className="h-7 w-auto" />
      </header>
      <main className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-lg">{children}</div>
      </main>
    </div>
  );
}
