'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { formatMoney } from '@meritbooks/shared';
import {
  Button,
  ButtonLink,
  Keyhints,
  Search,
  Seg,
  Select,
  Tabs,
  Tag,
  cx,
  useListKeynav,
} from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks/use-query';
import { CurrencyTag, EmptyState, PageHeader, TableSkeleton } from '@/components/ui';
import { ListPager } from '@/components/ui/list-pager';
import { InvoiceDrawer } from './invoice-drawer';
import { CreditMemosPanel, type CreditMemoPrefill } from './credit-memos-panel';
import { RecurringPanel } from './recurring-panel';
import { ContractImport } from './contract-import';
import { DocumentProposalsBanner } from '@/components/documents/document-proposals-banner';
import { useDocumentProposal, type ProposalWithDoc } from '@/components/documents/intelligence-client';
import { useHoverPeek, HoverPeekCard } from '@/components/hover-peek';
import { InvoicePeek } from './invoice-peek';
import { OnlineStatusCell } from './online-status';
import { InvoiceStatus } from './invoice-status';
import { CreateInvoiceForm } from './create-invoice-dialog';
import { PaymentDialog } from './receive-payment-dialog';
import type { InvoiceRow, LocationOption } from './invoice-types';
import s from './invoices.module.css';

// ─── Types ────────────────────────────────────────────────────────────

interface StatusCounts {
  [key: string]: { count: number; totalCents: number; balanceCents: number };
}

interface Pagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

type StatusTab = 'ALL' | 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'OVERDUE' | 'PAID';
type SortKey = 'invoiceNumber' | 'customer' | 'invoiceDate' | 'dueDate' | 'totalCents' | 'balanceCents';
type View = 'invoices' | 'recurring' | 'credit-memos' | 'unapplied';

const STATUS_TABS: ReadonlyArray<{ value: StatusTab; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'DRAFT', label: 'Draft' },
  // Open, unpaid and not yet due — issued (never emailed) or sent.
  { value: 'SENT', label: 'Not yet due' },
  { value: 'PARTIALLY_PAID', label: 'Partly paid' },
  { value: 'OVERDUE', label: 'Overdue' },
  { value: 'PAID', label: 'Paid' },
];

/** Payment can be received on a posted invoice with an open balance. */
const canReceive = (inv: InvoiceRow) => inv.status !== 'PAID' && inv.status !== 'VOIDED' && inv.status !== 'DRAFT';

function sortValue(inv: InvoiceRow, key: SortKey): string | number {
  switch (key) {
    case 'customer':
      return (inv.customer?.name ?? '').toLowerCase();
    case 'totalCents':
      return inv.totalCents;
    case 'balanceCents':
      return inv.balanceCents;
    default:
      return inv[key] ?? '';
  }
}

// ─── Invoice List Component ───────────────────────────────────────────

function InvoiceList({
  onCreateClick,
  onPaymentClick,
  onRowClick,
  keysEnabled,
}: {
  onCreateClick: () => void;
  onPaymentClick: (inv: InvoiceRow) => void;
  onRowClick: (id: string) => void;
  /** Off while a drawer or dialog owns the keyboard. */
  keysEnabled: boolean;
}) {
  const [status, setStatus] = useState<StatusTab>('ALL');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [locationId, setLocationId] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);
  const { peek, rowHandlers, cardHandlers, close } = useHoverPeek<InvoiceRow>();

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams();
  if (status !== 'ALL') params.set('status', status);
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (locationId) params.set('location_id', locationId);
  if (page > 1) params.set('page', String(page));

  const { data, isLoading, error, refetch } = useQuery<{
    data: InvoiceRow[];
    counts: StatusCounts;
    homeCurrency?: string;
    pagination?: Pagination;
  }>(`/api/invoices?${params}`);
  const homeCurrency = data?.homeCurrency ?? 'USD';

  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const locations = locData?.data ?? [];

  const counts = data?.counts ?? {};
  const pagination = data?.pagination;
  const filtered = status !== 'ALL' || !!debouncedSearch || !!locationId;

  // Sorting is client-side over the loaded page; the server orders by invoice date.
  const invoices = useMemo(() => {
    const rows = data?.data ?? [];
    if (!sort) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }, [data, sort]);

  const { activeIndex, setActiveIndex, rowProps } = useListKeynav({
    count: invoices.length,
    onOpen: (i) => {
      const inv = invoices[i];
      if (inv) onRowClick(inv.id);
    },
    onAction: (i) => {
      const inv = invoices[i];
      if (inv && canReceive(inv)) onPaymentClick(inv);
    },
    actionKey: 'p',
    enabled: keysEnabled,
    owner: 'Invoices list',
  });

  const toggleSort = (key: SortKey) =>
    setSort((cur) => (cur?.key !== key ? { key, dir: key === 'invoiceNumber' || key === 'customer' ? 'asc' : 'desc' } : cur.dir === 'asc' ? { key, dir: 'desc' } : null));

  const chooseStatus = (v: StatusTab) => {
    setStatus(v);
    setPage(1);
  };

  const clearFilters = () => {
    setStatus('ALL');
    setSearch('');
    setDebouncedSearch('');
    setLocationId('');
    setPage(1);
  };

  const sortHead = (key: SortKey, label: string, numeric = false) => {
    const dir = sort?.key === key ? sort.dir : null;
    return (
      <th scope="col" className={numeric ? 'n' : undefined} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}>
        <button type="button" className="th-sort" onClick={() => toggleSort(key)} aria-label={`Sort by ${label.toLowerCase()}`}>
          {label}
          {dir === 'asc' ? ' ↑' : dir === 'desc' ? ' ↓' : ''}
        </button>
      </th>
    );
  };

  const loadingFirst = isLoading && !data;

  // Outstanding = ALL open AR (sent + partially paid + overdue); Overdue is the
  // derived past-due subset (server: lib/ar/overdue), so the two always tie.
  const figures: ReadonlyArray<{ label: string; key: string; value: number; tab?: StatusTab; href?: string; link: string }> = [
    { label: 'Outstanding', key: 'OPEN', value: counts.OPEN?.balanceCents ?? 0, href: '/invoices/collections', link: 'Collections & DSO' },
    { label: 'Overdue', key: 'OVERDUE', value: counts.OVERDUE?.balanceCents ?? 0, tab: 'OVERDUE', link: 'Show overdue' },
    { label: 'Paid this month', key: 'PAID', value: counts.PAID?.totalCents ?? 0, tab: 'PAID', link: 'Show paid' },
    { label: 'Draft', key: 'DRAFT', value: counts.DRAFT?.totalCents ?? 0, tab: 'DRAFT', link: 'Show drafts' },
  ];

  return (
    <div>
      {/* Summary figures — each one goes somewhere. */}
      <div className={s.figs}>
        {figures.map((f) => {
          const n = counts[f.key]?.count ?? 0;
          return (
            <div key={f.label} className="fig">
              <span className="fig-l">{f.label}</span>
              {loadingFirst ? (
                <span className={cx('mb-skel', s.figSkel)} aria-hidden="true" />
              ) : (
                <span className="fig-v fig-v--dense tnum">{formatMoney(f.value)}</span>
              )}
              <span className="fig-vs">
                <span className="tnum">{loadingFirst ? '—' : `${n} invoice${n === 1 ? '' : 's'}`}</span>
              </span>
              {f.href ? (
                <Link href={f.href} className={s.figLink}>{f.link}</Link>
              ) : (
                <button type="button" className={s.figLink} onClick={() => f.tab && chooseStatus(f.tab)} aria-pressed={status === f.tab}>
                  {f.link}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Status · company · search */}
      <div className={s.toolbar}>
        <Seg<StatusTab>
          aria-label="Invoice status"
          value={status}
          onChange={chooseStatus}
          items={STATUS_TABS.map((t) => ({ value: t.value, label: t.label, count: counts[t.value]?.count ?? 0 }))}
        />
        <span className={s.toolbarSp} />
        <Select
          className={s.companySelect}
          value={locationId}
          onChange={(e) => {
            setLocationId(e.target.value);
            setPage(1);
          }}
          aria-label="Filter invoices by company"
        >
          <option value="">All companies</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </Select>
        <Search
          className={s.search}
          placeholder="Search number or memo"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search invoices"
        />
      </div>

      {/* Table — all four states */}
      {error ? (
        <div className={cx('surface', s.state)}>
          <div className="wg-state" role="alert">
            <Tag tone="neg">Not loaded</Tag>
            <span className="t-head">Invoices didn&apos;t load</span>
            <p>{error}</p>
            <Button onClick={() => void refetch()}>Try again</Button>
          </div>
        </div>
      ) : loadingFirst ? (
        <TableSkeleton rows={8} cols={8} />
      ) : invoices.length === 0 ? (
        <div className="surface">
          {filtered ? (
            <EmptyState
              title="No invoices match"
              description="Nothing fits this status, company and search. Clear the filters to see every invoice."
              action={{ label: 'Clear filters', onClick: clearFilters }}
            />
          ) : (
            <EmptyState
              title="No invoices yet"
              description="Create your first invoice to start billing customers and tracking receivables."
              action={{ label: 'New invoice', onClick: onCreateClick }}
            />
          )}
        </div>
      ) : (
        <>
          <div className={s.tableWrap} aria-busy={isLoading || undefined}>
            <table className={cx('tbl', 'tbl-q', s.table)} aria-label="Invoices">
              <colgroup>
                <col style={{ width: 150 }} />
                <col />
                <col style={{ width: 180 }} />
                <col style={{ width: 112 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 132 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 132 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 168 }} />
                <col style={{ width: 104 }} />
              </colgroup>
              <thead>
                <tr>
                  {sortHead('invoiceNumber', 'Invoice')}
                  {sortHead('customer', 'Customer')}
                  <th scope="col">Company</th>
                  {sortHead('invoiceDate', 'Date')}
                  {sortHead('dueDate', 'Due')}
                  {sortHead('totalCents', 'Total', true)}
                  <th scope="col" className="n">Paid</th>
                  {sortHead('balanceCents', 'Balance', true)}
                  <th scope="col">Status</th>
                  <th scope="col">Online</th>
                  <th scope="col"><span className="sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv, i) => {
                  const late = inv.daysOverdue > 0 && inv.status !== 'PAID';
                  return (
                    <tr
                      key={inv.id}
                      {...rowProps(i)}
                      {...rowHandlers(inv)}
                      onClick={() => {
                        setActiveIndex(i);
                        onRowClick(inv.id);
                      }}
                      className={cx('q-row', s.row, i === activeIndex && 'is-cursor', late && 'is-attn')}
                      aria-current={i === activeIndex || undefined}
                    >
                      <td>
                        <span className={s.inline}>
                          <span className="tnum" style={{ fontWeight: 600 }}>{inv.invoiceNumber}</span>
                          {inv.isProgressBill && <Tag title="Progress bill (AIA)">AIA</Tag>}
                        </span>
                      </td>
                      <td>{inv.customer?.name ?? '—'}</td>
                      <td>
                        {inv.location ? (
                          <span className={s.inline} title={inv.location.name}>
                            <Tag>{inv.location.shortCode}</Tag>
                            <span className="ink-2">{inv.location.name}</span>
                          </span>
                        ) : '—'}
                      </td>
                      <td className="tnum ink-2">{inv.invoiceDate}</td>
                      <td>
                        <span className={s.inline}>
                          <span className={cx('tnum', !late && 'ink-2')}>{inv.dueDate}</span>
                          {late && <Tag tone="neg">{inv.daysOverdue}d late</Tag>}
                        </span>
                      </td>
                      <td className="n">
                        <span className={s.inline}>
                          <CurrencyTag code={inv.currency} homeCurrency={homeCurrency} onlyForeign />
                          <span>{formatMoney(inv.totalCents, { currency: inv.currency })}</span>
                        </span>
                      </td>
                      <td className="n ink-2">{formatMoney(inv.amountPaidCents, { currency: inv.currency })}</td>
                      <td className="n" style={{ fontWeight: 600 }}>{formatMoney(inv.balanceCents, { currency: inv.currency })}</td>
                      <td><InvoiceStatus status={inv.status} hint={inv.statusHint} /></td>
                      <td><OnlineStatusCell online={inv.online} status={inv.status} /></td>
                      <td className="n">
                        {canReceive(inv) && (
                          <Button
                            variant="quiet"
                            onClick={(e) => { e.stopPropagation(); onPaymentClick(inv); }}
                            title="Receive payment (P)"
                            aria-label={`Receive payment for invoice ${inv.invoiceNumber}`}
                          >
                            Receive
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={s.tableFoot}>
            <Keyhints
              hints={[
                { chord: 'j k', label: 'move' },
                { chord: 'enter', label: 'open' },
                { chord: 'p', label: 'receive payment' },
                { chord: 'n', label: 'new invoice' },
              ]}
            />
            {pagination && pagination.total_pages > 1 && sort && (
              <span className="t-cap">Sorting applies to this page.</span>
            )}
          </div>
          {pagination && (
            <ListPager
              page={pagination.page}
              perPage={pagination.per_page}
              total={pagination.total}
              noun="invoices"
              onPageChange={setPage}
              isLoading={isLoading}
            />
          )}
        </>
      )}

      <HoverPeekCard
        rect={peek?.rect ?? null}
        visible={!!peek}
        cardHandlers={cardHandlers}
        onOpen={peek ? () => { const id = peek.item.id; close(); onRowClick(id); } : undefined}
      >
        {peek && <InvoicePeek invoiceId={peek.item.id} />}
      </HoverPeekCard>
    </div>
  );
}

// ─── Main Manager ─────────────────────────────────────────────────────

const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: 'invoices', label: 'Invoices' },
  { value: 'recurring', label: 'Recurring' },
  { value: 'credit-memos', label: 'Credit memos' },
  { value: 'unapplied', label: 'Unapplied payments' },
];

export function InvoiceManager() {
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [paymentInvoice, setPaymentInvoice] = useState<InvoiceRow | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [view, setView] = useState<View>('invoices');
  const [creditPrefill, setCreditPrefill] = useState<CreditMemoPrefill | null>(null);
  // Document intelligence: a customer contract AI found in Documents (banner Review or ?proposal=).
  const deepLinked = useDocumentProposal('customer_contract');
  const [fromDoc, setFromDoc] = useState<ProposalWithDoc | null>(null);
  const reviewingContract = fromDoc ?? deepLinked.proposal;

  // Deep-link: open the panel from ?invoice=<id> on load, and keep the URL in
  // sync so a refresh re-opens it and the link is shareable.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get('invoice') ?? q.get('id');
    if (id) setDetailId(id);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (detailId) url.searchParams.set('invoice', detailId);
    else url.searchParams.delete('invoice');
    window.history.replaceState(null, '', url.toString());
  }, [detailId]);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setShowCreate(false);
    setShowImport(false);
    setPaymentInvoice(null);
  }, []);

  const overlayOpen = !!detailId || showCreate || showImport || !!paymentInvoice || !!reviewingContract;

  return (
    <div key={refreshKey}>
      <PageHeader
        eyebrow={['Receivables', VIEWS.find((v) => v.value === view)?.label ?? 'Invoices']}
        title="Invoices"
        description="Create, send and track customer invoices, recurring billing and credits."
        actions={
          <>
            <ButtonLink href="/invoices/collections">Collections &amp; DSO</ButtonLink>
            <ButtonLink href="/invoices/design">Design invoices</ButtonLink>
            {view === 'invoices' && (
              <>
                <Button onClick={() => setShowImport(true)}>Import from contract</Button>
                <Button variant="primary" icon="plus" chord="n" bindChord={!overlayOpen} onClick={() => setShowCreate(true)}>
                  New invoice
                </Button>
              </>
            )}
          </>
        }
      />

      {/* View switcher: customer invoices ⇄ recurring ⇄ credit memos ⇄ unapplied (all AR). */}
      <Tabs<View> aria-label="Receivables views" className={s.viewTabs} value={view} onChange={setView} items={VIEWS} />

      {view === 'invoices' ? (
        <>
          {/* Customer contracts found in Documents (document intelligence). */}
          <DocumentProposalsBanner kind="customer_contract" refreshKey={refreshKey} onReview={(p) => setFromDoc(p)} />
          <InvoiceList
            onCreateClick={() => setShowCreate(true)}
            onPaymentClick={(inv) => setPaymentInvoice(inv)}
            onRowClick={(id) => setDetailId(id)}
            keysEnabled={!overlayOpen}
          />
          <InvoiceDrawer
            invoiceId={detailId}
            onClose={() => setDetailId(null)}
            onCreateCreditMemo={(ctx) => {
              setDetailId(null);
              setCreditPrefill(ctx);
              setView('credit-memos');
            }}
          />
          {showCreate && <CreateInvoiceForm onClose={() => setShowCreate(false)} onCreated={refresh} />}
          {showImport && !reviewingContract && <ContractImport onClose={() => setShowImport(false)} onCreated={refresh} />}
          {reviewingContract && (
            <ContractImport
              key={reviewingContract.id}
              fromProposal={reviewingContract}
              onClose={() => { setFromDoc(null); deepLinked.clear(); }}
              onCreated={() => { setFromDoc(null); deepLinked.clear(); refresh(); }}
            />
          )}
          {paymentInvoice && <PaymentDialog invoice={paymentInvoice} onClose={() => setPaymentInvoice(null)} onPaid={refresh} />}
        </>
      ) : view === 'recurring' ? (
        <RecurringPanel />
      ) : view === 'credit-memos' ? (
        <CreditMemosPanel prefill={creditPrefill} onConsumePrefill={() => setCreditPrefill(null)} />
      ) : (
        // TODO(cash-application): another builder owns the real Cash Application
        // "Unapplied payments" embed (Bank Feed / Cash-App slice). This is a stub
        // tab that reserves the spot and links out to /cash-application for now.
        // When that panel lands, replace this block with the embedded component;
        // do NOT change the `unapplied` tab key or the tab above.
        <div className="surface">
          <div className={cx('wg-state', s.state)}>
            <span className="wg-empty-mark" aria-hidden="true" />
            <span className="t-head">Unapplied payments live in Cash application</span>
            <p>
              Received payments that aren&apos;t yet matched to an open invoice show up there. Apply them to clear
              customer balances and keep receivables tied out.
            </p>
            <ButtonLink href="/cash-application" variant="primary" iconAfter="right">Open cash application</ButtonLink>
          </div>
        </div>
      )}
    </div>
  );
}
