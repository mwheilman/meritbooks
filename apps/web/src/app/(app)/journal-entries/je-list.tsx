'use client';

import { useState, useEffect, useMemo } from 'react';
import { Button, Icon, Keyhints, Search, Tabs, Tag, cx, useListKeynav } from '@meritbooks/merit-ui';
import { StatusBadge, EmptyState, TableSkeleton } from '@/components/ui';
import { ListPager } from '@/components/ui/list-pager';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useDebounce } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { JournalEntryDrawer } from './je-drawer';
import { useHoverPeek, HoverPeekCard } from '@/components/hover-peek';
import { JournalEntryPeek } from './je-peek';
import { jeDeepLinkId, withCanonicalJeId } from '@/lib/je-deep-link';
import { JE_SOURCE_LABELS, JE_TYPE_LABELS } from './je-labels';
import s from './je.module.css';

interface JERow {
  id: string;
  entryNumber: string;
  entryDate: string;
  entryType: string;
  memo: string | null;
  sourceModule: string | null;
  status: string;
  postedAt: string | null;
  createdBy: string;
  location: { id: string; name: string; short_code: string } | null;
  totalDebitCents: number;
  lineCount: number;
}

interface JEResponse {
  data: JERow[];
  counts: Record<string, number>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'POSTED', label: 'Posted' },
  { key: 'VOIDED', label: 'Voided' },
] as const;

type SortKey = 'entryDate' | 'entryNumber' | 'totalDebitCents';
type SortDir = 'asc' | 'desc';

export function JournalEntryList() {
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
  const { peek, rowHandlers, cardHandlers, close } = useHoverPeek<JERow>();

  // Deep-link: open the drawer from ?id=<uuid> on load (e.g. an Explain "based on"
  // link), and keep the URL in sync so the record is shareable and refresh-safe.
  // A bad/missing id degrades to the list, as before.
  // `?entry=` and `?highlight=` (payroll, internal invoices, search) are
  // honored too and normalized to `?id=`. The linked row is also highlighted
  // and scrolled into view once the list loads.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    const id = jeDeepLinkId(window.location.search);
    if (id) {
      setSelectedId(id);
      setHighlightId(id);
    }
  }, []);
  useEffect(() => {
    window.history.replaceState(null, '', withCanonicalJeId(window.location.href, selectedId));
  }, [selectedId]);

  // Server-side paging (the API returns 50 per page, newest first). A filter
  // change goes back to page 1.
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [activeTab, debouncedSearch, locationId]);

  const params: Record<string, string> = {};
  if (activeTab !== 'all') params.status = activeTab;
  if (debouncedSearch) params.search = debouncedSearch;
  if (locationId) params.location_id = locationId;
  if (page > 1) params.page = String(page);

  const { data, isLoading, error, refetch } = useQuery<JEResponse>(
    '/api/journal-entries',
    Object.keys(params).length > 0 ? params : undefined,
  );

  const pagination = data?.pagination ?? null;
  useEffect(() => {
    if (pagination && pagination.total > 0 && page > pagination.total_pages) setPage(pagination.total_pages);
  }, [pagination, page]);

  // Column sort re-orders the loaded page; the default is the server's order
  // (newest entry date first).
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const entries = useMemo(() => {
    const rows = data?.data ?? [];
    if (!sort) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [data, sort]);
  const toggleSort = (key: SortKey) =>
    setSort((cur) => (cur?.key === key ? (cur.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: 'desc' }));
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const sortMark = (key: SortKey) => (sort?.key === key ? <Icon name={sort.dir === 'asc' ? 'up' : 'down'} /> : null);

  useEffect(() => {
    if (!highlightId || entries.length === 0) return;
    const row = document.querySelector<HTMLElement>(`[data-je-id="${highlightId}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [highlightId, entries.length]);
  const counts = data?.counts ?? null;

  // J/K move the cursor, Enter opens the entry (paused while the drawer is open).
  const showTable = !isLoading && !error && entries.length > 0;
  const { setActiveIndex, rowProps } = useListKeynav({
    count: showTable ? entries.length : 0,
    onOpen: (i) => {
      const je = entries[i];
      if (je) { close(); setSelectedId(je.id); }
    },
    enabled: !selectedId,
    owner: 'Journal entries list',
  });

  const filtered = activeTab !== 'all' || !!debouncedSearch;

  return (
    <div className={s.stack}>
      <Tabs<string>
        aria-label="Journal entry status"
        value={activeTab}
        onChange={setActiveTab}
        items={TABS.map((tab) => ({
          value: tab.key,
          label: tab.label,
          count: counts ? counts[tab.key] ?? 0 : '—',
        }))}
      />

      <div className={s.toolbar}>
        <Search
          aria-label="Search journal entries by entry number or memo"
          className={s.searchBox}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by entry # or memo"
          slashToFocus
        />
        <div className={s.grow} />
        {pagination && pagination.total > 0 && (
          <span className="t-cap tnum">
            {pagination.total} entr{pagination.total === 1 ? 'y' : 'ies'} · {sort ? 'sorted on this page' : 'newest first'}
          </span>
        )}
      </div>

      {isLoading ? (
        <TableSkeleton rows={8} cols={9} />
      ) : error ? (
        <div className={s.state} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <p className="t-head">Couldn&apos;t load journal entries.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : entries.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No entries match"
            description="No journal entries match this status or search. Try another tab or clear the search."
            action={{ label: 'Show all entries', onClick: () => { setActiveTab('all'); setSearch(''); } }}
          />
        ) : (
          <EmptyState
            title="No journal entries yet"
            description="Post your first manual entry with New entry, or describe a transaction and let Compose with AI draft it."
          />
        )
      ) : (
        <div>
          <div className={s.tableWrap}>
            <table className="tbl tbl-q" aria-label="Journal entries">
              <colgroup>
                <col style={{ width: 132 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 128 }} />
                <col />
                <col style={{ width: 96 }} />
                <col style={{ width: 112 }} />
                <col style={{ width: 144 }} />
                <col style={{ width: 72 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 48 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" aria-sort={ariaSort('entryNumber')}>
                    <button type="button" className="mb-th-btn" onClick={() => toggleSort('entryNumber')}>Entry #{sortMark('entryNumber')}</button>
                  </th>
                  <th scope="col" aria-sort={ariaSort('entryDate')}>
                    <button type="button" className="mb-th-btn" onClick={() => toggleSort('entryDate')}>Date{sortMark('entryDate')}</button>
                  </th>
                  <th scope="col">Source</th>
                  <th scope="col">Memo</th>
                  <th scope="col">Company</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="n" aria-sort={ariaSort('totalDebitCents')}>
                    <button type="button" className="mb-th-btn" onClick={() => toggleSort('totalDebitCents')}>{sortMark('totalDebitCents')}Debits</button>
                  </th>
                  <th scope="col" className="n">Lines</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((je, i) => {
                  const source = JE_SOURCE_LABELS[je.sourceModule ?? ''] ?? JE_SOURCE_LABELS.SYSTEM;
                  const { ref, 'data-active': active } = rowProps(i);
                  const linked = highlightId === je.id;
                  return (
                    <tr
                      key={je.id}
                      ref={ref}
                      {...rowHandlers(je)}
                      data-je-id={je.id}
                      aria-current={active || linked ? 'true' : undefined}
                      onClick={() => { setActiveIndex(i); setSelectedId(je.id); }}
                      className={cx('q-row', active && 'is-cursor', linked && 'is-selected')}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="tnum">{je.entryNumber}</td>
                      <td className="tnum">{je.entryDate}</td>
                      <td><Tag tone={je.sourceModule === 'MANUAL' ? 'default' : 'ai'}>{source}</Tag></td>
                      <td title={je.memo ?? undefined}>{je.memo ?? <span className="ink-3">—</span>}</td>
                      <td>
                        {je.location ? <Tag title={je.location.name}>{je.location.short_code}</Tag> : <span className="ink-3">—</span>}
                      </td>
                      <td className="ink-2">{JE_TYPE_LABELS[je.entryType] ?? je.entryType}</td>
                      <td className="n">{formatMoney(je.totalDebitCents)}</td>
                      <td className="n ink-2">{je.lineCount}</td>
                      <td><StatusBadge status={je.status} /></td>
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
              noun="entries"
              onPageChange={setPage}
              isLoading={isLoading}
            />
          )}
          <Keyhints
            className={s.hints}
            hints={[
              { chord: 'j k', label: 'Move' },
              { chord: 'enter', label: 'Open entry' },
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
        {peek && <JournalEntryPeek entryId={peek.item.id} />}
      </HoverPeekCard>

      <JournalEntryDrawer entryId={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}
