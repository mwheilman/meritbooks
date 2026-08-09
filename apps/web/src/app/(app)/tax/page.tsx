import Link from 'next/link';
import { Scale, Landmark, MapPin, FileCheck, ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { HubTabs } from '../_components/hub-tabs';

const CARDS = [
  {
    href: '/book-to-tax',
    icon: Scale,
    title: 'Book-to-Tax (Schedule M-1)',
    body: 'Bridge book net income to taxable income — every difference classified permanent vs temporary on its labeled M-1 line.',
  },
  {
    href: '/tax-provision',
    icon: Landmark,
    title: 'Tax Provision (ASC 740)',
    body: 'Current + deferred tax from the book-to-tax differences, with the DTA/DTL rollforward and effective-rate reconciliation.',
  },
  {
    href: '/tax/sales-tax',
    icon: MapPin,
    title: 'Sales Tax',
    body: 'The multi-jurisdiction return worksheet with GL tie-out, plus the filing calendar and liability-owed dashboard.',
  },
  {
    href: '/tax-package',
    icon: FileCheck,
    title: 'Tax Return Package',
    body: 'A 1120-style hand-off an accountant can take straight to the return — M-1, tax depreciation, and the ASC 740 provision, aggregated.',
  },
];

export default function TaxHubPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Tax"
        description="Book-to-tax reconciliation, the ASC 740 income-tax provision, sales-tax filings, and the return-package hand-off — in one place."
      />
      <HubTabs section="tax" />
      <div className="grid gap-3 sm:grid-cols-2">
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
