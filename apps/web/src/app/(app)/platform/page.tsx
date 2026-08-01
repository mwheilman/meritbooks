import { redirect } from 'next/navigation';
import { KeyRound, ToggleRight, Building2 } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { resolvePlatformStaff } from '@/app/api/platform/_lib/platform-auth';
import { FeeRevenueReport } from './_components/fee-revenue-report';

export const dynamic = 'force-dynamic';

// Remaining operator-console surfaces still to be built (shown below the live
// fee-revenue report so the plane's roadmap stays visible).
const SECTIONS = [
  { icon: Building2, title: 'Tenants', desc: 'Provision and manage merchant/customer organizations.' },
  { icon: KeyRound, title: 'Licensing & Seats', desc: 'Plans, seat counts, and term per tenant.' },
  { icon: ToggleRight, title: 'Entitlements', desc: 'Toggle features (bank feed, consolidation, analytics) per tenant.' },
];

export default async function PlatformPage() {
  // PLATFORM-PLANE GATE. This console is cross-tenant; only platform staff may
  // reach it. Fail closed: unauthenticated → sign-in; non-staff → bounce to their
  // own book-of-record dashboard (a 403-equivalent redirect).
  const { clerkUserId, isPlatformStaff } = await resolvePlatformStaff();
  if (!clerkUserId) redirect('/');
  if (!isPlatformStaff) redirect('/dashboard');

  return (
    <>
      <PageHeader
        title="Operator Console"
        description="MeritBooks platform administration — cross-tenant fee revenue and oversight."
      />

      {/* Live: cross-tenant application-fee revenue the platform operator earned. */}
      <FeeRevenueReport />

      {/* Roadmap: the rest of the operator plane. */}
      <div className="mt-8">
        <p className="text-2xs uppercase tracking-wider text-slate-500 mb-3">More operator tools</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.title} className="card p-5 flex items-start gap-3 opacity-70">
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
      </div>
    </>
  );
}
