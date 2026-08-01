import { currentOrgId, getEntitlements } from '@/lib/entitlements';

export const dynamic = 'force-dynamic';

// G0' dashboard: proves the app boots, is entitlement-gated, and is wired to the
// shared DB under RLS. Feature tiles populate as gates G1-G11 ship.
export default async function Dashboard() {
  const orgId = await currentOrgId();
  const ents = await getEntitlements(orgId);

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-title text-white">Dashboard</h1>
        <p className="text-sm text-slate-400">
          MeritProjects is live and connected to the suite. Modules activate gate by gate.
        </p>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Tile label="App status" value="Online" tone="success" />
        <Tile label="Entitlement" value={ents.projects ? 'projects ✓' : '—'} tone="info" />
        <Tile label="Shared ledger" value={ents.books ? 'Books present' : 'Standalone'} tone="ai" />
      </section>

      <section className="rounded-xl border border-surface-800 bg-surface-900 p-6">
        <div className="text-heading text-white mb-2">Build roadmap</div>
        <ol className="text-sm text-slate-400 space-y-1 num">
          <li>G0′ App stand-up — <span className="text-brand-400">this</span></li>
          <li>G1 Polymorphic core + seam activation</li>
          <li>G2 Leads / opportunities · G3 Estimates · G4 Jobs (hinge)</li>
          <li>G5 Cost + commitments · G6 Schedule/field · G7 Billing engines</li>
          <li>G8 Recurring service · G9 Warranty · G10 Portal/Copilot · G11 Proof</li>
        </ol>
      </section>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone: 'success' | 'info' | 'ai' }) {
  const ring = tone === 'success' ? 'text-success-fg' : tone === 'info' ? 'text-info-fg' : 'text-ai-fg';
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-5">
      <div className="text-2xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 text-heading font-semibold ${ring}`}>{value}</div>
    </div>
  );
}
