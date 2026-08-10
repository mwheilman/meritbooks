import { redirect } from 'next/navigation';
import { ToggleRight, Receipt } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { resolvePlatformStaff } from '@/app/api/platform/_lib/platform-auth';
import { OperatorDashboard } from './_components/operator-dashboard';
import { FeeRevenueReport } from './_components/fee-revenue-report';
import { OpsHealthDashboard } from './_components/ops-health-dashboard';

export const dynamic = 'force-dynamic';

// Remaining operator-console surfaces still to be built (shown below the live
// business dashboard so the plane's roadmap stays visible).
const SECTIONS = [
  { icon: ToggleRight, title: 'Entitlements', desc: 'Toggle features (bank feed, consolidation, analytics) per tenant.' },
  { icon: Receipt, title: 'Billing activation', desc: 'List-price MRR is computed from each tenant’s plan below. Activate live charging to issue subscription invoices.' },
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
        description="MeritBooks platform business — tenants, revenue, and the cost to run them, across every tenant."
      />

      {/* Live: the cross-tenant operator business dashboard (tenants, revenue, costs). */}
      <OperatorDashboard />

      {/* Revenue deep-dive: realized processor-fee revenue, by rail / tenant / month. */}
      <div className="mt-10">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-white">Processor fee revenue — detail</h2>
          <p className="text-sm text-slate-500">
            The application fee earned on card and ACH collections, broken out by rail, tenant, and month.
          </p>
        </div>
        <FeeRevenueReport />
      </div>

      {/* Ops health: internal observability — captured failures across all tenants. */}
      <div className="mt-10">
        <OpsHealthDashboard />
      </div>

      {/* Roadmap: the rest of the operator plane. */}
      <div className="mt-10">
        <p className="text-2xs uppercase tracking-wider text-slate-500 mb-3">More operator tools</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
