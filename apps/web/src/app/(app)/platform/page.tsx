import { Building2, KeyRound, ToggleRight, Activity } from 'lucide-react';
import { PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

const SECTIONS = [
  { icon: Building2, title: 'Tenants', desc: 'Provision and manage merchant/customer organizations.' },
  { icon: KeyRound, title: 'Licensing & Seats', desc: 'Plans, seat counts, and term per tenant.' },
  { icon: ToggleRight, title: 'Entitlements', desc: 'Toggle features (bank feed, consolidation, analytics) per tenant.' },
  { icon: Activity, title: 'Cross-tenant Health', desc: 'Portfolio view of tenant activity and health.' },
];

export default function PlatformPage() {
  return (
    <>
      <PageHeader
        title="Operator Console"
        description="MeritBooks platform administration — provisioning, licensing, and cross-tenant oversight."
      />
      <div className="rounded-xl border border-brand-500/20 bg-brand-500/5 px-4 py-3 mb-6">
        <p className="text-sm text-brand-300">
          This is the <span className="font-semibold">platform operator</span> plane, separate from your
          practice and book-of-record views. The console below is in progress.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.title} className="card p-5 flex items-start gap-3 opacity-80">
              <div className="h-9 w-9 rounded-lg bg-slate-800 flex items-center justify-center shrink-0">
                <Icon size={18} className="text-slate-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-white">{s.title}</h3>
                  <span className="text-2xs uppercase tracking-wider text-slate-500 bg-slate-800 rounded px-1.5 py-0.5">
                    Soon
                  </span>
                </div>
                <p className="text-sm text-slate-400 mt-0.5">{s.desc}</p>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
