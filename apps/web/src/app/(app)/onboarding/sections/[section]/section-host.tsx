'use client';

/**
 * SectionHost — client mount for a single Wave-1 onboarding domain section, keyed by the
 * URL slug. This is the "shell owns the per-section UI" seam: the Setup Home board deep-
 * links here and this component renders the domain's ReviewComponent, wired to the live
 * tenant context (active company + onboarding status) each one needs.
 *
 * Mapping (slug → ReviewComponent):
 *   customers-ar → ArReviewComponent        vendors-ap  → ApReviewComponent
 *   jobs-wip     → WipReview                 debt        → DebtSection
 *   leases       → LeasesSection             fixed-assets→ FixedAssetsSection
 * (equity has its own dedicated page.)
 *
 * Degrade-safe: fetches are best-effort; AR/AP/WIP need a company (clear empty state when
 * none exists); Debt/Leases/Fixed-assets read onboarding status for their board badge.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/company-scope';
import type { OnboardingStatus } from '@/lib/onboarding/status';
import { ArReviewComponent } from '@/components/onboarding/sections/ar-review';
import { ApReviewComponent } from '@/components/onboarding/sections/ap-review';
import { WipReview } from '@/components/onboarding/wip-review';
import { DebtSection } from '../debt-section';
import { LeasesSection } from '../leases-section';
import { FixedAssetsSection } from '../fixed-assets-section';

interface Company { id: string; name: string }

/** Section metadata (title + which live context it needs). */
const SECTION_META: Record<string, { title: string; blurb: string; needs: 'company' | 'status' }> = {
  'customers-ar': { title: 'Customers & A/R', blurb: 'Bring in your customers and open receivables — they foot to the A/R control.', needs: 'company' },
  'vendors-ap': { title: 'Vendors & A/P', blurb: 'Bring in your vendors and open payables — they foot to the A/P control.', needs: 'company' },
  'jobs-wip': { title: 'Jobs & WIP', blurb: 'Drop a WIP schedule — we build the opening position and tie it to the ledger.', needs: 'company' },
  debt: { title: 'Debt & loans', blurb: 'Drop a loan agreement and we build the amortization schedule + covenants.', needs: 'status' },
  leases: { title: 'Leases', blurb: 'Drop a lease PDF for the ROU asset and lease liability (ASC 842).', needs: 'status' },
  'fixed-assets': { title: 'Fixed assets', blurb: 'Drop a register or capex invoices to build depreciation.', needs: 'status' },
};

function readActiveCompanyCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${ACTIVE_COMPANY_COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export default function SectionHost({ section }: { section: string }) {
  const meta = SECTION_META[section];

  const [companies, setCompanies] = useState<Company[]>([]);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/onboarding/status');
      if (res.ok) setStatus((await res.json()) as OnboardingStatus);
    } catch { /* best-effort — the board badge simply shows add-later */ }
  }, []);

  useEffect(() => {
    if (!meta) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const jobs: Promise<unknown>[] = [loadStatus()];
      if (meta.needs === 'company') {
        jobs.push(
          fetch('/api/locations')
            .then((r) => (r.ok ? r.json() : []))
            .then((d) => {
              if (cancelled) return;
              const list = Array.isArray(d) ? d : [];
              setCompanies(list.map((l: { id: string; name: string }) => ({ id: l.id, name: l.name })));
            })
            .catch(() => { /* empty state handles it */ }),
        );
      }
      await Promise.all(jobs);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [meta, loadStatus]);

  const activeCompany = useMemo(() => {
    if (companies.length === 0) return null;
    const cookieId = readActiveCompanyCookie();
    return companies.find((c) => c.id === cookieId) ?? companies[0];
  }, [companies]);

  if (!meta) {
    return (
      <Shell title="Section not found" blurb="That setup section doesn’t exist.">
        <p className="text-sm text-slate-400">Head back to your setup board to pick a domain.</p>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell title={meta.title} blurb={meta.blurb}>
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </p>
      </Shell>
    );
  }

  // Domains that need a company but have none → clear, actionable empty state.
  if (meta.needs === 'company' && !activeCompany) {
    return (
      <Shell title={meta.title} blurb={meta.blurb}>
        <div className="rounded-xl border border-warning/25 bg-warning/5 p-4 text-sm text-warning-fg">
          Create a company first — this data is scoped to a specific company.{' '}
          <Link href="/onboarding" className="underline">Go to onboarding</Link>.
        </div>
      </Shell>
    );
  }

  let body: ReactNode = null;
  switch (section) {
    case 'customers-ar':
      body = <ArReviewComponent companyId={activeCompany!.id} companyName={activeCompany!.name} onCommitted={() => void loadStatus()} />;
      break;
    case 'vendors-ap':
      body = <ApReviewComponent companyId={activeCompany!.id} companyName={activeCompany!.name} onCommitted={() => void loadStatus()} />;
      break;
    case 'jobs-wip':
      body = <WipReview companyId={activeCompany!.id} onCommitted={() => void loadStatus()} />;
      break;
    case 'debt':
      body = <DebtSection status={status} onCommitted={() => void loadStatus()} />;
      break;
    case 'leases':
      body = <LeasesSection status={status} onCommitted={() => void loadStatus()} />;
      break;
    case 'fixed-assets':
      body = <FixedAssetsSection status={status} onCommitted={() => void loadStatus()} />;
      break;
  }

  return <Shell title={meta.title} blurb={meta.blurb}>{body}</Shell>;
}

function Shell({ title, blurb, children }: { title: string; blurb: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link href="/onboarding" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300">
        <ArrowLeft size={13} /> Back to setup
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-white">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">{blurb}</p>
      </div>
      {children}
    </div>
  );
}
