'use client';

/**
 * Lenders summary: this client's floor-plan lines and how many programs they carry.
 * The full lines & programs editor is the floor-plan setup tab (another slice).
 */

import Link from 'next/link';
import { Landmark } from 'lucide-react';
import { LINE_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { money } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { nameOf, useDealerQuery, useNames, type ListPage } from '../../_lib/use-dealer';
import { Empty, ErrorPanel, Mono, Pill, Section } from '../../_components/ui';

/** floor_plan_lines columns read here (migration 169). */
interface LineLite {
  id: string;
  name: string;
  lender_vendor_id: string;
  credit_limit_cents: number;
  status: 'ACTIVE' | 'SUSPENDED' | 'CREDIT_HOLD' | 'CLOSED';
}

export function LendersSection() {
  const lines = useDealerQuery<ListPage<LineLite>>('/api/dealer/lines', { per_page: 100, sort: 'name', dir: 'asc' });
  const programs = useDealerQuery<ListPage<{ id: string }>>('/api/dealer/programs', { per_page: 1 });
  const rows = lines.data?.rows ?? [];
  const vendors = useNames('vendors', rows.map((r) => r.lender_vendor_id));
  const setup = dealerLinks.floorPlan('setup');

  return (
    <Section
      id="lenders"
      className="scroll-mt-6"
      title="Lenders"
      description="Floor-plan lines and their programs (free-floor days, rates, curtailments). Lenders don’t block switching the pack on."
      actions={
        <Link href={setup} className="btn-secondary btn-sm">
          Set up lines & programs
        </Link>
      }
    >
      {lines.error ? (
        <ErrorPanel error={lines.error} onRetry={() => void lines.refetch()} />
      ) : lines.isLoading && !lines.data ? (
        <div className="space-y-2 p-5" aria-busy>
          {[0, 1].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-slate-800/60" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Empty
          icon={Landmark}
          title="No floor-plan lines yet"
          description="Add each lender’s line and its programs so flooring, interest and curtailments calculate correctly."
          action={
            <Link href={setup} className="btn-primary btn-sm">
              Add a line
            </Link>
          }
        />
      ) : (
        <>
          <table className="w-full text-body">
            <caption className="sr-only">Floor-plan lines</caption>
            <thead>
              <tr className="border-b border-slate-800 text-caption uppercase tracking-caps text-slate-500">
                <th scope="col" className="px-5 py-2 text-left">Line</th>
                <th scope="col" className="px-5 py-2 text-left">Lender</th>
                <th scope="col" className="px-5 py-2 text-right">Credit limit</th>
                <th scope="col" className="px-5 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {rows.map((l) => (
                <tr key={l.id} className="table-row-hover">
                  <td className="px-5 py-2.5 text-slate-100">{l.name}</td>
                  <td className="px-5 py-2.5 text-slate-300">{nameOf(vendors, l.lender_vendor_id)}</td>
                  <td className="px-5 py-2.5 text-right"><Mono className="text-white">{money(l.credit_limit_cents)}</Mono></td>
                  <td className="px-5 py-2.5"><Pill label={labelOf(LINE_STATUS, l.status)} tone={toneOf(LINE_STATUS, l.status)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-slate-800 px-5 py-3 text-xs text-slate-500">
            {rows.length} line{rows.length === 1 ? '' : 's'} ·{' '}
            {programs.data ? `${programs.data.total} program${programs.data.total === 1 ? '' : 's'}` : programs.error ? 'programs unavailable' : 'counting programs…'} ·{' '}
            <Link href={setup} className="text-emerald-400 hover:text-emerald-300">
              Edit in floor-plan setup
            </Link>
          </p>
        </>
      )}
    </Section>
  );
}
