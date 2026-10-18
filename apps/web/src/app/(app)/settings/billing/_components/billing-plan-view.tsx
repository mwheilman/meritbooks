'use client';

/**
 * Tenant plan & cost page (Settings → Billing).
 *
 * Shows this organization's subscription plan, its active company count, and the computed
 * monthly/annual cost with a per-line breakdown — all read from /api/billing/plan, which
 * prices the plan through the shared, deterministic pricing model. Nothing here charges the
 * tenant: live billing activation is a separate, gated step, so the page shows a clear
 * "coming soon" state instead of a pay button. White-label copy (no operator name hardcoded).
 */

import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { clsx } from 'clsx';
import { BuildStatusBadge } from '@/components/brand';
import {
  Loader2,
  AlertCircle,
  CreditCard,
  Building2,
  Layers,
  CalendarClock,
  Info,
  Zap,
  Landmark,
} from 'lucide-react';

type BillingPlan = 'direct' | 'firm' | 'enterprise';

interface PricingLine {
  label: string;
  quantity: number;
  unitCents: number;
  subtotalCents: number;
  kind: 'platform_fee' | 'tier' | 'custom';
}
interface MrrBreakdown {
  plan: BillingPlan;
  count: number;
  lines: PricingLine[];
  mrrCents: number;
  arrCents: number;
  usesCustom: boolean;
}
interface PlanResponse {
  org: { id: string; name: string | null };
  plan: BillingPlan;
  activeCompanies: number;
  customMrrCents: number | null;
  breakdown: MrrBreakdown;
  usage: { achBps: number; cardBps: number };
  enterpriseMinCompanies: number;
  billingActivated: boolean;
}

const PLAN_META: Record<BillingPlan, { label: string; blurb: string; icon: typeof CreditCard }> = {
  direct: {
    label: 'Direct',
    blurb: '$99 per company for your first 5, $59 for each additional company.',
    icon: Building2,
  },
  firm: {
    label: 'Firm · white-label',
    blurb: '$499 platform fee plus volume-tiered wholesale for each client entity you manage.',
    icon: Layers,
  },
  enterprise: {
    label: 'Enterprise',
    blurb: 'A custom agreement tailored to your organization.',
    icon: Landmark,
  },
};

const bps = (b: number) => `${(b / 100).toFixed(b % 100 === 0 ? 0 : 2)}%`;

export function BillingPlanView() {
  const { data, isLoading, error } = useQuery<PlanResponse>('/api/billing/plan', {}, { scope: false });

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card p-5 animate-pulse">
              <div className="h-3 w-24 bg-slate-800 rounded" />
              <div className="mt-4 h-7 w-28 bg-slate-800 rounded" />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (error || !data) {
    return (
      <div className="card p-10 text-center">
        <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
        <p className="text-sm text-red-400">{error ?? 'Unable to load your plan.'}</p>
        <p className="text-xs text-slate-500 mt-1">Please try again, or contact your administrator.</p>
      </div>
    );
  }

  const { plan, activeCompanies, breakdown, usage, enterpriseMinCompanies, billingActivated } = data;
  const meta = PLAN_META[plan];
  const PlanIcon = meta.icon;
  const entityNoun = plan === 'firm' ? 'client entities' : 'companies';

  // ── Empty-ish: no billable entities yet ──────────────────────────────────────
  const hasEntities = activeCompanies > 0;

  return (
    <div className="space-y-6">
      {/* Plan header */}
      <div className="card p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="h-11 w-11 rounded-xl bg-emerald-500/10 flex items-center justify-center shrink-0">
              <PlanIcon size={22} className="text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-white">{meta.label} plan</h2>
                <span className="text-2xs uppercase tracking-wider text-emerald-300/80 bg-emerald-500/10 rounded px-1.5 py-0.5">
                  Current
                </span>
              </div>
              <p className="text-sm text-slate-400 mt-1 max-w-xl">{meta.blurb}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xs uppercase tracking-wider text-slate-500">Monthly cost</p>
            <p className="text-3xl font-semibold text-white font-mono tabular-nums tracking-tight">
              {formatMoney(breakdown.mrrCents)}
            </p>
            <p className="text-2xs text-slate-500 mt-0.5 font-mono">
              {formatMoney(breakdown.arrCents)} / year
            </p>
          </div>
        </div>
      </div>

      {/* Snapshot KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Kpi
          icon={Building2}
          label={`Active ${entityNoun}`}
          value={activeCompanies.toLocaleString()}
          accent="indigo"
        />
        <Kpi icon={CreditCard} label="Monthly (MRR)" value={formatMoney(breakdown.mrrCents)} accent="emerald" mono />
        <Kpi icon={CalendarClock} label="Annualized (ARR)" value={formatMoney(breakdown.arrCents)} accent="slate" mono />
      </div>

      {/* Cost breakdown */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-2">
          <Layers size={14} className="text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-200">How your monthly cost is calculated</h3>
        </div>
        {!hasEntities ? (
          <div className="p-10 text-center">
            <Building2 size={24} className="text-slate-600 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No active {entityNoun} yet.</p>
            <p className="text-xs text-slate-600 mt-1">
              Add {entityNoun} to your organization and your plan cost will appear here.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-2xs uppercase tracking-wider text-slate-500">
                <th className="px-5 py-2.5 text-left font-semibold">Line</th>
                <th className="px-5 py-2.5 text-right font-semibold">Qty</th>
                <th className="px-5 py-2.5 text-right font-semibold">Rate</th>
                <th className="px-5 py-2.5 text-right font-semibold">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.lines.map((line, i) => (
                <tr key={i} className="border-b border-slate-800/40">
                  <td className="px-5 py-2.5 text-slate-200">
                    {line.label}
                    {line.kind === 'platform_fee' && (
                      <span className="ml-2 text-2xs text-slate-500">flat</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-right font-mono text-slate-400 tabular-nums">
                    {line.quantity > 0 ? line.quantity.toLocaleString() : '—'}
                  </td>
                  <td className="px-5 py-2.5 text-right font-mono text-slate-400 tabular-nums">
                    {line.quantity > 0 ? `${formatMoney(line.unitCents)}/mo` : formatMoney(line.unitCents)}
                  </td>
                  <td className="px-5 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                    {formatMoney(line.subtotalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-800/20 border-t border-slate-700">
                <td className="px-5 py-2.5 text-sm font-semibold text-white" colSpan={3}>
                  Total monthly
                </td>
                <td className="px-5 py-2.5 text-right font-mono text-emerald-400 tabular-nums font-semibold">
                  {formatMoney(breakdown.mrrCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
        {plan === 'enterprise' && breakdown.usesCustom && (
          <div className="px-5 py-3 border-t border-slate-800 flex items-start gap-2 text-2xs text-slate-500">
            <Info size={12} className="mt-0.5 shrink-0" />
            <p>This reflects your negotiated enterprise agreement.</p>
          </div>
        )}
        {plan === 'enterprise' && !breakdown.usesCustom && (
          <div className="px-5 py-3 border-t border-slate-800 flex items-start gap-2 text-2xs text-slate-500">
            <Info size={12} className="mt-0.5 shrink-0" />
            <p>
              No custom amount is on file, so this is estimated using standard per-company pricing.
              Enterprise agreements typically apply at {enterpriseMinCompanies}+ companies.
            </p>
          </div>
        )}
      </div>

      {/* Usage-based fees (informational) */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Zap size={14} className="text-amber-400" />
          <h3 className="text-sm font-semibold text-slate-200">Payment processing (usage-based)</h3>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          When your customers pay invoices online, a processing fee applies to the amount collected.
          These are separate from your subscription and only apply to what you actually process.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Bank transfer (ACH)</span>
              <span className="font-mono text-lg text-white tabular-nums">{bps(usage.achBps)}</span>
            </div>
            <p className="text-2xs text-slate-500 mt-1">Of the amount collected · no cap</p>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Card</span>
              <span className="font-mono text-lg text-white tabular-nums">{bps(usage.cardBps)}</span>
            </div>
            <p className="text-2xs text-slate-500 mt-1">Of the amount collected</p>
          </div>
        </div>
      </div>

      {/* Billing activation — coming soon (no charge button) */}
      <div
        className={clsx(
          'card p-5 border',
          billingActivated ? 'border-emerald-500/20' : 'border-dashed border-slate-700 bg-slate-900/40',
        )}
      >
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg bg-slate-800 flex items-center justify-center shrink-0">
            <CreditCard size={18} className="text-slate-400" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-white">Billing activation coming soon</h3>
              <BuildStatusBadge
                status={billingActivated ? 'live' : 'development'}
                label={billingActivated ? 'Live billing' : 'Live billing — in development'}
                title={
                  billingActivated
                    ? 'Automated billing is switched on for this account.'
                    : 'Automated billing and invoicing are not switched on for this account yet — no charge is created from this page.'
                }
              />
            </div>
            <p className="text-sm text-slate-400 mt-1 max-w-2xl">
              Your plan and cost above are calculated automatically. Automated billing and invoicing
              aren&apos;t switched on for your account yet — you won&apos;t be charged through this page. To
              activate billing or discuss your plan, contact us.
            </p>
            <button
              type="button"
              disabled
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-400 cursor-not-allowed"
              title="Billing activation is not available yet"
            >
              <CreditCard size={13} />
              Activate billing (coming soon)
            </button>
          </div>
        </div>
      </div>

      {/* Honesty footnote */}
      <div className="flex items-start gap-2 text-[11px] text-slate-600">
        <Info size={12} className="mt-0.5 shrink-0" />
        <p>
          Costs are computed from your current plan and active {entityNoun} count using the standard
          pricing model. This is what your subscription would total — no charge is created from this
          page.
        </p>
      </div>
    </div>
  );
}

type Accent = 'indigo' | 'emerald' | 'slate';
const ACCENT: Record<Accent, { bg: string; fg: string }> = {
  indigo: { bg: 'bg-indigo-500/15', fg: 'text-indigo-300' },
  emerald: { bg: 'bg-emerald-500/10', fg: 'text-emerald-400' },
  slate: { bg: 'bg-slate-700/40', fg: 'text-slate-300' },
};

function Kpi({
  icon: Icon,
  label,
  value,
  accent = 'slate',
  mono = false,
}: {
  icon: typeof CreditCard;
  label: string;
  value: string;
  accent?: Accent;
  mono?: boolean;
}) {
  const a = ACCENT[accent];
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm text-slate-400">{label}</p>
        <div className={clsx('h-8 w-8 rounded-lg flex items-center justify-center', a.bg)}>
          <Icon size={16} className={a.fg} />
        </div>
      </div>
      <p
        className={clsx(
          'mt-2 text-2xl font-semibold text-white tracking-tight',
          mono && 'font-mono tabular-nums',
        )}
      >
        {value}
      </p>
    </div>
  );
}
