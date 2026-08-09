export default function DashboardLoading() {
  return (
    <div>
      <div className="mb-6">
        <div className="h-6 w-32 rounded bg-slate-800 animate-pulse mb-2" />
        <div className="h-4 w-96 max-w-full rounded bg-slate-800/50 animate-pulse" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <div className="card h-20 animate-pulse" />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card h-56 animate-pulse" />
            ))}
          </div>
        </div>
        <div className="card h-64 animate-pulse" />
      </div>
    </div>
  );
}
