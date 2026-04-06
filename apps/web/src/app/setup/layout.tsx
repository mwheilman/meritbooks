export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* Minimal header */}
      <header className="border-b border-slate-800/50 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">M</span>
          </div>
          <span className="text-lg font-semibold text-white tracking-tight">MeritBooks</span>
          <span className="text-xs text-slate-500 ml-2">Setup</span>
        </div>
      </header>
      <main className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-2xl">
          {children}
        </div>
      </main>
    </div>
  );
}
