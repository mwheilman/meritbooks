'use client';

import { useState, useEffect } from 'react';
import {
  Button,
  Icon,
  Keyhints,
  Search,
  Status,
  Tabs,
  Tag,
  cx,
  useListKeynav,
} from '@meritbooks/merit-ui';
import { StatusBadge, EmptyState, TableSkeleton, CurrencyTag } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { ListPager } from '@/components/ui/list-pager';
import { useQuery, useDebounce } from '@/hooks';
import { useHoverPeek, HoverPeekCard } from '@/components/hover-peek';
import { BillPeek } from './bill-peek';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { BillDetail } from './bill-detail';
import s from './bills.module.css';

interface BillRow {
  id: string;
  bill_number: string | null;
  bill_date: string;
  due_date: string;
  currency: string | null;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  status: string;
  ai_extracted: boolean;
  ai_confidence: number | null;
  payment_hold_reason: string | null;
  approver_type: string | null;
  approver_ref: string | null;
  scheduled_payment_date: string | null;
  daysUntilDue: number | null;
  jobLines: number;
  location: { id: string; name: string; short_code: string } | null;
  vendor: { id: string; name: string; display_name: string | null; is_1099_eligible: boolean } | null;
  compliance: { missing: string[]; hasHold: boolean } | null;
}

interface BillResponse {
  data: BillRow[];
  counts: Record<string, { count: number; amount_cents: number }>;
  homeCurrency?: string;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

const TAB_CONFIG = [
  { key: 'all', label: 'All open' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'SCHEDULED', label: 'Scheduled' },
  { key: 'ON_HOLD', label: 'On hold' },
  { key: 'PAID', label: 'Paid' },
] as const;

const APPROVER_LABEL: Record<string, string> = {
  ACCOUNTING: 'Accounting',
  RESPONSIBLE_PARTY: 'Responsible party',
  PM_LEADER: 'PM / Leader',
};

export function BillList() {
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  // Company scope is owned by the header picker + <CompanyScopeGuard> (this page
  // is behind the guard, so a specific company is always active). Derive the
  // location from the shared active-company context instead of a redundant
  // in-page selector; useQuery also auto-attaches it as `location_id`.
  const { activeCompanyId } = useActiveCompany();
  const locationId = isSpecificCompany(activeCompanyId) ? activeCompanyId : null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { peek, rowHandlers, cardHandlers, close } = useHoverPeek<BillRow>();

  // Deep-link: open the bill detail from ?id=<uuid> on load (e.g. an Explain
  // "based on" link), and keep the URL in sync so it's shareable and refresh-safe.
  // A bad/missing id degrades to the list, as before.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) setSelectedId(id);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set('id', selectedId);
    else url.searchParams.delete('id');
    window.history.replaceState(null, '', url.toString());
  }, [selectedId]);

  // Server-side paging (the API returns 50/page). A filter change resets to
  // page 1; previously the list silently stopped at the first 50 rows.
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [activeTab, debouncedSearch, locationId]);

  const params: Record<string, string> = {};
  if (activeTab !== 'all') params.status = activeTab;
  if (debouncedSearch) params.search = debouncedSearch;
  if (locationId) params.location_id = locationId;
  if (page > 1) params.page = String(page);

  const { data, isLoading, error, refetch } = useQuery<BillResponse>(
    '/api/bills',
    Object.keys(params).length > 0 ? params : undefined,
  );

  const bills = data?.data ?? [];
  const pagination = data?.pagination ?? null;
  // If the current page emptied out (e.g. rows approved away), step back.
  useEffect(() => {
    if (pagination && pagination.total > 0 && page > pagination.total_pages) setPage(pagination.total_pages);
  }, [pagination, page]);
  const counts = data?.counts ?? null;
  const homeCurrency = data?.homeCurrency ?? 'USD';

  // J/K move the cursor, Enter opens the bill (paused while the drawer is open).
  const showTable = !isLoading && !error && bills.length > 0;
  const { activeIndex, setActiveIndex, rowProps } = useListKeynav({
    count: showTable ? bills.length : 0,
    onOpen: (i) => {
      const b = bills[i];
      if (b) { close(); setSelectedId(b.id); }
    },
    enabled: !selectedId,
    owner: 'Bills list',
  });

  const filtered = activeTab !== 'all' || !!debouncedSearch;

  return (
    <div className={s.stack}>
      <Tabs<string>
        aria-label="Bill status"
        value={activeTab}
        onChange={setActiveTab}
        items={TAB_CONFIG.map((tab) => {
          const stats = counts?.[tab.key] ?? null;
          return {
            value: tab.key,
            label: tab.label,
            count: stats ? `${stats.count} · ${formatMoney(stats.amount_cents, { compact: true })}` : '—',
          };
        })}
      />

      <div className={s.toolbar}>
        <Search
          aria-label="Search bills by bill number"
          className={s.searchBox}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by bill number"
          slashToFocus
        />
        <div className={s.grow} />
        {pagination && pagination.total > 0 && (
          <span className="t-cap tnum">{pagination.total} bill{pagination.total === 1 ? '' : 's'} · soonest due first</span>
        )}
      </div>

      {isLoading ? (
        <TableSkeleton rows={6} cols={9} />
      ) : error ? (
        <div className={s.state} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <p className="t-head">Couldn&apos;t load bills.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : bills.length === 0 ? (
        <EmptyState
          title={filtered ? 'No bills match' : 'No open bills'}
          description={
            filtered
              ? 'Try another status tab or clear the search.'
              : 'Add a bill with New bill, auto-file one from a PDF, or email it to the AP inbox above.'
          }
          action={filtered ? { label: 'Show all open bills', onClick: () => { setActiveTab('all'); setSearch(''); } } : undefined}
        />
      ) : (
        <div>
          <div className={s.tableWrap}>
            <table className="tbl tbl-q" aria-label="Bills">
              <colgroup>
                <col style={{ width: 132 }} />
                <col />
                <col style={{ width: 96 }} />
                <col style={{ width: 156 }} />
                <col style={{ width: 168 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 48 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Bill #</th>
                  <th scope="col">Vendor</th>
                  <th scope="col">Company</th>
                  <th scope="col">Approver</th>
                  <th scope="col">Due</th>
                  <th scope="col" className="n">Amount</th>
                  <th scope="col" className="n">Balance</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {bills.map((bill, i) => {
                  const vendorName = bill.vendor?.display_name ?? bill.vendor?.name ?? 'Unknown vendor';
                  const hasComplianceIssue = !!bill.compliance && (bill.compliance.missing.length > 0 || bill.compliance.hasHold);
                  const isOverdue = bill.daysUntilDue !== null && bill.daysUntilDue < 0;
                  const isDueSoon = bill.daysUntilDue !== null && bill.daysUntilDue >= 0 && bill.daysUntilDue <= 7;
                  const { ref, 'data-active': active } = rowProps(i);
                  const ccy = bill.currency ?? homeCurrency;

                  return (
                    <tr
                      key={bill.id}
                      ref={ref}
                      {...rowHandlers(bill)}
                      onClick={() => { setActiveIndex(i); setSelectedId(bill.id); }}
                      className={cx('q-row', active && 'is-cursor', (hasComplianceIssue || isOverdue) && 'is-attn')}
                      aria-current={active ? 'true' : undefined}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="tnum">{bill.bill_number ?? '—'}</td>
                      <td>
                        <div className={s.cellRow}>
                          <span className="l1">{vendorName}</span>
                          {bill.jobLines > 0 && (
                            <Tag tone="ai" title={`${bill.jobLines} job-tagged line(s)`}>
                              <span className="tnum">{bill.jobLines}</span> job
                            </Tag>
                          )}
                          {hasComplianceIssue && (
                            <Tag tone="neg" title={bill.compliance?.missing.join(', ') || 'Payment hold'}>
                              {bill.compliance?.hasHold ? 'Hold' : 'Docs missing'}
                            </Tag>
                          )}
                          {bill.vendor?.is_1099_eligible && <Tag>1099</Tag>}
                        </div>
                      </td>
                      <td>
                        {bill.location ? <Tag title={bill.location.name}>{bill.location.short_code}</Tag> : <span className="ink-3">—</span>}
                      </td>
                      <td>
                        {bill.approver_type ? (
                          <span className="ink-2">{APPROVER_LABEL[bill.approver_type] ?? bill.approver_type}</span>
                        ) : (
                          <span className="ink-3">—</span>
                        )}
                      </td>
                      <td>
                        <span className={s.due}>
                          <span className="tnum">{bill.due_date}</span>
                          {isOverdue && (
                            <Status kind="overdue">{Math.abs(bill.daysUntilDue ?? 0)}d late</Status>
                          )}
                          {isDueSoon && !isOverdue && <Status kind="risk">Soon</Status>}
                        </span>
                      </td>
                      <td className="n">
                        <span className={s.due}>
                          <CurrencyTag code={bill.currency} homeCurrency={homeCurrency} onlyForeign />
                          {formatMoney(bill.total_cents, { currency: ccy })}
                        </span>
                      </td>
                      <td className="n">{formatMoney(bill.balance_cents, { currency: ccy })}</td>
                      <td><StatusBadge status={bill.status} /></td>
                      <td className="n ink-3" aria-hidden="true"><Icon name="right" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pagination && (
            <ListPager
              page={pagination.page}
              perPage={pagination.per_page}
              total={pagination.total}
              noun="bills"
              onPageChange={setPage}
              isLoading={isLoading}
            />
          )}
          <Keyhints
            className={s.hints}
            hints={[
              { chord: 'j k', label: 'Move' },
              { chord: 'enter', label: 'Open bill' },
              { chord: '/', label: 'Search' },
            ]}
          />
        </div>
      )}

      <HoverPeekCard
        rect={peek?.rect ?? null}
        visible={!!peek}
        cardHandlers={cardHandlers}
        onOpen={peek ? () => { const id = peek.item.id; close(); setSelectedId(id); } : undefined}
      >
        {peek && <BillPeek billId={peek.item.id} />}
      </HoverPeekCard>

      {selectedId && (
        <BillDetail
          billId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => refetch()}
        />
      )}
    </div>
  );
}
