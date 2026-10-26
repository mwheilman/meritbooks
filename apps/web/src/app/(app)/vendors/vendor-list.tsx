'use client';

import { useState } from 'react';
import { Button, Pip, Search, Seg, Tag, type PipKind } from '@meritbooks/merit-ui';
import { ConfidenceBar, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useDebounce } from '@/hooks';
import { useHoverPeek, HoverPeekCard } from '@/components/hover-peek';
import { VendorPeek } from './vendor-peek';
import { VendorDrawer } from './vendor-drawer';
import s from './vendors.module.css';

interface VendorRow {
  id: string;
  name: string;
  displayName: string;
  defaultAccount: string | null;
  ai_confidence: number;
  auto_approve: boolean;
  transaction_count: number;
  ytd_spend_cents: number;
  is_1099_eligible: boolean;
  compliance: { w9: string; glCoi: string; wcCoi: string };
  hasPaymentHold: boolean;
  hasComplianceIssue: boolean;
}

interface VendorResponse {
  data: VendorRow[];
  pagination: { page: number; per_page: number; total: number; total_pages: number };
  summary: { total: number; withIssues: number; with1099: number };
}

const LOOK: Record<string, { pip: PipKind; word: string }> = {
  VALID: { pip: 'ready', word: 'Valid' },
  VERIFIED: { pip: 'ready', word: 'Verified' },
  EXPIRED: { pip: 'overdue', word: 'Expired' },
  MISSING: { pip: 'blocked', word: 'Missing' },
  PENDING: { pip: 'open', word: 'Pending' },
};

/** Pip shape + word — status is never colour alone. */
function ComplianceIcon({ status }: { status: string }) {
  const look = LOOK[status];
  if (!look) return <span className="ink-3">—</span>;
  return (
    <span className="mb-sev" style={{ fontWeight: 400 }}>
      <Pip kind={look.pip} />
      {look.word}
    </span>
  );
}

const FILTER_TABS = [
  { key: 'all', label: 'All vendors' },
  { key: 'issues', label: 'Compliance issues' },
  { key: 'compliant', label: 'Compliant' },
] as const;
type FilterKey = (typeof FILTER_TABS)[number]['key'];

/**
 * Compact vendor directory (AI defaults + compliance at a glance). Not mounted by the
 * /vendors page today; kept on the kit so it can be embedded elsewhere.
 */
export function VendorList() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [filter, setFilter] = useState<FilterKey>('all');

  const params: Record<string, string> = {};
  if (debouncedSearch) params.search = debouncedSearch;
  if (filter !== 'all') params.compliance = filter;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { peek, rowHandlers, cardHandlers, close } = useHoverPeek<VendorRow>();

  const { data, isLoading, error, refetch } = useQuery<VendorResponse>(
    '/api/vendors',
    Object.keys(params).length > 0 ? params : undefined,
  );

  const vendors = data?.data ?? [];
  const summary = data?.summary ?? null;

  return (
    <div>
      {/* Summary strip */}
      {summary && (
        <div className={`${s.toolbar} surface`} style={{ padding: '8px 16px' }} role="status">
          <span className="ink-2">Total vendors <b className="tnum" style={{ color: 'var(--ink)' }}>{summary.total}</b></span>
          <span className="mb-sev" style={{ fontWeight: 400 }}>
            <Pip kind={summary.withIssues > 0 ? 'risk' : 'ready'} /> With issues <b className="tnum">{summary.withIssues}</b>
          </span>
          <span className="ink-2">1099 vendors <b className="tnum" style={{ color: 'var(--ink)' }}>{summary.with1099}</b></span>
        </div>
      )}

      <div className={s.toolbar}>
        <Seg<FilterKey>
          aria-label="Compliance filter"
          value={filter}
          onChange={setFilter}
          items={FILTER_TABS.map((t) => ({ value: t.key, label: t.label }))}
        />
        <Search className={s.searchBox} aria-label="Search vendors" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search vendors" />
      </div>

      {isLoading ? (
        <TableSkeleton rows={8} cols={9} />
      ) : error ? (
        <div className={`wg-state ${s.errorState}`} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <span className="t-head">The vendor list didn’t load.</span>
          <p className="ink-2">{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : vendors.length === 0 ? (
        <div className={s.state}>
          <EmptyState title="No vendors match." description="No vendors match your search or filter. Try another name or band." />
        </div>
      ) : (
        <div className={s.tableWrap}>
          <table className="tbl tbl-q" aria-label="Vendors">
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Default account</th>
                <th scope="col">AI confidence</th>
                <th scope="col" className="n">Txns</th>
                <th scope="col" className="n">YTD spend</th>
                <th scope="col">W-9</th>
                <th scope="col">GL COI</th>
                <th scope="col">WC COI</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.id} {...rowHandlers(v)} onClick={() => setSelectedId(v.id)} className={`q-row${v.hasPaymentHold ? ' is-attn' : ''}`} style={{ cursor: 'pointer' }}>
                  <td>
                    <span className={s.rowMeta}>
                      <span className="l1">{v.displayName}</span>
                      {v.hasPaymentHold && <Tag tone="neg">On hold</Tag>}
                      {v.auto_approve && <Tag tone="ai">Auto</Tag>}
                      {v.is_1099_eligible && <Tag>1099</Tag>}
                    </span>
                  </td>
                  <td>
                    {v.defaultAccount ? <span className="tnum ink-2">{v.defaultAccount}</span> : <span className="ink-3">None</span>}
                  </td>
                  <td><ConfidenceBar value={v.ai_confidence} /></td>
                  <td className="n tnum">{v.transaction_count}</td>
                  <td className="n tnum">{formatMoney(v.ytd_spend_cents, { compact: true })}</td>
                  <td><ComplianceIcon status={v.compliance.w9} /></td>
                  <td><ComplianceIcon status={v.compliance.glCoi} /></td>
                  <td><ComplianceIcon status={v.compliance.wcCoi} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <HoverPeekCard
        rect={peek?.rect ?? null}
        visible={!!peek}
        cardHandlers={cardHandlers}
        onOpen={peek ? () => { const id = peek.item.id; close(); setSelectedId(id); } : undefined}
      >
        {peek && <VendorPeek vendorId={peek.item.id} />}
      </HoverPeekCard>

      <VendorDrawer vendorId={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}
