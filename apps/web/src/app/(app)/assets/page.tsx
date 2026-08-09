import Link from 'next/link';
import { Package, FileText, Receipt, ShieldCheck, Sparkles, Calculator, ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { HubTabs } from '../_components/hub-tabs';

const CARDS = [
  {
    href: '/fixed-assets',
    icon: Package,
    title: 'Fixed Assets',
    body: 'The capital-asset register — depreciation methods, disposals, and the accumulated-depreciation roll-forward.',
  },
  {
    href: '/leases',
    icon: FileText,
    title: 'Leases',
    body: 'ASC 842 right-of-use assets and lease liabilities — drop a lease, confirm the terms, and post each period.',
  },
  {
    href: '/prepaids',
    icon: Receipt,
    title: 'Prepaids',
    body: 'Prepaid-expense amortization schedules — straight-line from the prepaid asset into expense, posted monthly.',
  },
  {
    href: '/insurance',
    icon: ShieldCheck,
    title: 'Insurance',
    body: 'The policy register — carrier, coverage, limits, deductible, and premium, with renewal flags before coverage lapses.',
  },
  {
    href: '/intangibles',
    icon: Sparkles,
    title: 'Intangibles',
    body: 'Finite-lived intangibles amortized straight-line, with goodwill held for impairment (ASC 350).',
  },
  {
    href: '/tax-depreciation',
    icon: Calculator,
    title: 'Tax Depreciation',
    body: 'The parallel MACRS / §179 / bonus tax book, reconciled to posted book depreciation and fed to Schedule M-1.',
  },
];

export default function AssetsHubPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Assets & Schedules"
        description="Every capitalized asset and amortization schedule in one place — fixed assets, leases, prepaids, insurance, intangibles, and the parallel tax-depreciation book."
      />
      <HubTabs section="assets" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => {
          const Icon = c.icon;
          return (
            <Link
              key={c.href}
              href={c.href}
              className="card group p-4 transition-colors hover:border-brand-500/40"
            >
              <div className="flex items-start gap-3">
                <span className="rounded-lg bg-brand-500/10 p-2 text-brand-400">
                  <Icon size={18} />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
                    {c.title}
                    <ArrowRight size={14} className="text-slate-600 transition-colors group-hover:text-brand-400" />
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{c.body}</p>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
