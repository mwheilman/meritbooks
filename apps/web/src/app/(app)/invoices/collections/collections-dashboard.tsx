'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button,
  ButtonLink,
  Icon,
  Input,
  Keybar,
  Pip,
  QueueTable,
  Seg,
  Select,
  Tabs,
  Tag,
  cx,
  useListKeynav,
  type PipKind,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { EmptyState, PageHeader, TableSkeleton } from '@/components/ui';
import { AgingBars, ChartCard, agingLegend, agingTable, summarizeAging, type AgingRow } from '@/components/charts';
import { InvoiceDrawer } from '../invoice-drawer';
import s from './collections-dashboard.module.css';

// ─── Types (mirror the /api/invoices/collections payload) ─────────────────

type Bucket = 'CURRENT' | '1-30' | '31-60' | '61-90' | '90+';
type BucketMap = Record<Bucket, { count: number; balanceCents: number }>;

interface WorklistItem {
  id: string; invoiceNumber: string; customerId: string | null; customerName: string;
  customerEmail: string | null; invoiceDate: string; dueDate: string;
  totalCents: number; balanceCents: number; daysOverdue: number; bucket: Bucket;
  status: string; locationName: string | null; locationCode: string | null;
  lastSentAt: string | null; sentCount: number;
  lastViewedAt: string | null; viewCount: number;
  lastReminderAt: string | null; reminderCount: number;
  priorityScore: number;
}

interface CustomerRollup {
  customerId: string | null; customerName: string; customerEmail: string | null;
  openBalanceCents: number; overdueBalanceCents: number; invoiceCount: number;
  overdueCount: number; oldestDaysOverdue: number; avgDaysToPay: number | null;
  lastContactAt: string | null; buckets: BucketMap; invoices: WorklistItem[];
}

interface CollectionsPayload {
  asOf: string; agingMethod: 'DUE_DATE' | 'INVOICE_DATE'; dsoDays: number;
  kpis: {
    totalArCents: number; overdueArCents: number; currentArCents: number;
    pctCurrent: number | null; dso: number | null; avgDaysToPay: number | null;
    creditSalesCents: number; openInvoiceCount: number; overdueInvoiceCount: number;
    customerCount: number;
  };
  buckets: BucketMap;
  worklist: WorklistItem[];
  customers: CustomerRollup[];
}

interface LocationOption { id: string; name: string; short_code: string }

const BUCKET_ORDER: Bucket[] = ['CURRENT', '1-30', '31-60', '61-90', '90+'];
const BUCKET_LABEL: Record<Bucket, string> = {
  CURRENT: 'Current', '1-30': '1–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '90+': '90+ days',
};
/** Severity by pip SHAPE (+ the bucket word) — never colour alone. */
const BUCKET_PIP: Record<Bucket, PipKind> = {
  CURRENT: 'ready', '1-30': 'soft', '31-60': 'risk', '61-90': 'overdue', '90+': 'blocked',
};
const AGING_BUCKETS = BUCKET_ORDER.map((b) => ({ key: b, label: BUCKET_LABEL[b] }));
/** Customers drawn as their own bar in the aging chart; the rest fold into one row. */
const CHART_TOP = 7;

// ─── Small formatters ─────────────────────────────────────────────────────

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
const fmtWhenLong = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
const custKey = (c: { customerId: string | null }) => c.customerId ?? 'UNASSIGNED';

// ─── Sorting for the worklist ──────────────────────────────────────────────

type SortKey = 'priority' | 'balance' | 'daysOverdue' | 'customer' | 'due';
function sortWorklist(rows: WorklistItem[], key: SortKey, dir: 1 | -1): WorklistItem[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    let d = 0;
    switch (key) {
      case 'priority': d = a.priorityScore - b.priorityScore; break;
      case 'balance': d = a.balanceCents - b.balanceCents; break;
      case 'daysOverdue': d = a.daysOverdue - b.daysOverdue; break;
      case 'customer': d = a.customerName.localeCompare(b.customerName); break;
      case 'due': d = a.dueDate.localeCompare(b.dueDate); break;
    }
    return d * dir;
  });
  return copy;
}

// ─── Main ──────────────────────────────────────────────────────────────────

export function CollectionsDashboard({ embedded = false }: { embedded?: boolean } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const [locationId, setLocationId] = useState('');
  const [asOf, setAsOf] = useState(today);
  const [agingMethod, setAgingMethod] = useState<'DUE_DATE' | 'INVOICE_DATE'>('DUE_DATE');
  const [dsoDays, setDsoDays] = useState('90');
  const [tab, setTab] = useState<'worklist' | 'customers'>('worklist');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [remindingId, setRemindingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (locationId) params.set('location_id', locationId);
  if (asOf) params.set('as_of', asOf);
  params.set('aging_method', agingMethod);
  params.set('dso_days', dsoDays);

  const { data, isLoading, error, refetch } = useQuery<CollectionsPayload>(
    `/api/invoices/collections?${params.toString()}`,
    undefined,
    { key: String(reloadKey) },
  );
  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const locations = locData?.data ?? [];

  async function sendReminder(inv: WorklistItem) {
    if (!inv.customerEmail) {
      addToast('error', `${inv.customerName} has no email address on file.`);
      return;
    }
    setRemindingId(inv.id);
    try {
      const res = await fetch(`/api/invoices/${inv.id}/remind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'MANUAL' }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.sent) {
        addToast('success', `Reminder sent to ${body.to}`);
        setReloadKey((k) => k + 1);
        refetch();
      } else {
        addToast('error', body.error ?? 'Could not send the reminder.');
      }
    } catch {
      addToast('error', 'Could not reach the send service. Try again.');
    } finally {
      setRemindingId(null);
    }
  }

  // Aging chart drill: a customer bar → that customer, expanded; the totals → the worklist.
  const drill = (rowKey: string) => {
    if (rowKey === '__all' || rowKey === '__other') { setTab('worklist'); return; }
    setTab('customers');
    setExpandedCustomer(rowKey);
  };

  const loadingFirst = isLoading && !data;

  return (
    <div className={s.stack}>
      {/* Header — hidden when embedded in the Collections tab shell (which owns the page chrome). */}
      {!embedded && (
        <PageHeader
          eyebrow={['Receivables', 'Invoices & AR']}
          title="Collections & DSO"
          description="Aging, days sales outstanding, and the overdue worklist."
          actions={<ButtonLink href="/invoices" variant="quiet" icon="left">Invoices &amp; AR</ButtonLink>}
        />
      )}

      {/* Controls */}
      <div className={s.toolbar}>
        <Select
          aria-label="Filter collections by company"
          className={s.companySelect}
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">All companies</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>

        <label className={s.inline}>
          <span className="t-cap">As of</span>
          <Input type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} aria-label="As of date" />
        </label>

        <Seg<'DUE_DATE' | 'INVOICE_DATE'>
          aria-label="Aging method"
          value={agingMethod}
          onChange={setAgingMethod}
          items={[
            { value: 'DUE_DATE', label: 'Age by due date' },
            { value: 'INVOICE_DATE', label: 'Age by invoice date' },
          ]}
        />

        <label className={s.inline}>
          <span className="t-cap">DSO window</span>
          <Select value={dsoDays} onChange={(e) => setDsoDays(e.target.value)} aria-label="DSO window">
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
            <option value="180">180 days</option>
            <option value="365">365 days</option>
          </Select>
        </label>
      </div>

      {/* Error */}
      {error ? (
        <div className={s.state} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <p className="t-head">Couldn&apos;t load collections.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => { setReloadKey((k) => k + 1); void refetch(); }}>Try again</Button>
        </div>
      ) : loadingFirst || !data ? (
        <>
          <FigureStrip loading />
          <TableSkeleton rows={6} cols={7} />
        </>
      ) : (
        <>
          <FigureStrip data={data} onShowWorklist={() => setTab('worklist')} />

          {/* Aging */}
          <AgingSection data={data} onDrill={drill} />

          {/* Tabs */}
          <Tabs<'worklist' | 'customers'>
            aria-label="Collections list"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'worklist', label: 'Worklist', count: data.worklist.length },
              { value: 'customers', label: 'By customer', count: data.customers.length },
            ]}
          />

          {tab === 'worklist' ? (
            <Worklist rows={data.worklist} onOpen={setDrawerId} onRemind={sendReminder} remindingId={remindingId} keysOn={!drawerId} />
          ) : (
            <CustomerTable
              customers={data.customers}
              expanded={expandedCustomer}
              setExpanded={setExpandedCustomer}
              onOpen={setDrawerId}
              onRemind={sendReminder}
              remindingId={remindingId}
              keysOn={!drawerId}
            />
          )}
        </>
      )}

      <InvoiceDrawer invoiceId={drawerId} onClose={() => { setDrawerId(null); setReloadKey((k) => k + 1); refetch(); }} />
    </div>
  );
}

// ─── Figure strip ──────────────────────────────────────────────────────────

function FigureStrip({ data, loading, onShowWorklist }: { data?: CollectionsPayload; loading?: boolean; onShowWorklist?: () => void }) {
  const k = data?.kpis;
  const figs: ReadonlyArray<{ label: string; value: string; sub: string; link?: React.ReactNode }> = [
    {
      label: 'Total AR',
      value: k ? formatMoney(k.totalArCents) : '',
      sub: k ? `${k.customerCount} customers` : '',
      link: <ButtonLinkPlain href="/invoices">Open invoices</ButtonLinkPlain>,
    },
    {
      label: 'Overdue AR',
      value: k ? formatMoney(k.overdueArCents) : '',
      sub: k ? `${k.overdueInvoiceCount} invoices` : '',
      link: onShowWorklist ? <button type="button" className={s.figLink} onClick={onShowWorklist}>Show worklist</button> : undefined,
    },
    {
      label: 'DSO',
      value: k ? (k.dso != null ? `${k.dso}d` : '—') : '',
      sub: k ? (k.dso != null ? `over ${data?.dsoDays}d of credit sales` : 'no credit sales') : '',
    },
    {
      label: 'Avg days to pay',
      value: k ? (k.avgDaysToPay != null ? `${k.avgDaysToPay}d` : '—') : '',
      sub: k ? (k.avgDaysToPay != null ? `trailing ${data?.dsoDays}d` : 'no paid invoices') : '',
    },
    {
      label: '% Current',
      value: k ? (k.pctCurrent != null ? `${k.pctCurrent}%` : '—') : '',
      sub: k ? `${formatMoney(k.currentArCents)} within terms` : '',
    },
  ];
  return (
    <div className={s.figs} aria-busy={loading || undefined}>
      {figs.map((f) => (
        <div key={f.label} className="fig">
          <span className="fig-l">{f.label}</span>
          {loading ? (
            <span className={cx('mb-skel', s.figSkel)} aria-hidden="true" />
          ) : (
            <span className="fig-v fig-v--dense tnum">{f.value}</span>
          )}
          <span className="fig-vs"><span className="tnum">{loading ? '—' : f.sub}</span></span>
          {!loading && f.link}
        </div>
      ))}
    </div>
  );
}

function ButtonLinkPlain({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className={s.figLink}>{children}</Link>;
}

// ─── Aging (kit chart + bucket strip) ──────────────────────────────────────

function AgingSection({ data, onDrill }: { data: CollectionsPayload; onDrill: (rowKey: string) => void }) {
  const total = data.kpis.totalArCents;
  const rows = useMemo<AgingRow[]>(() => {
    const ranked = [...data.customers].sort((a, b) => b.openBalanceCents - a.openBalanceCents);
    const top = ranked.slice(0, CHART_TOP);
    const rest = ranked.slice(CHART_TOP);
    const out: AgingRow[] = top.map((c) => ({
      key: custKey(c),
      label: c.customerName,
      sub: `${c.invoiceCount} inv`,
      values: BUCKET_ORDER.map((b) => c.buckets[b]?.balanceCents ?? 0),
    }));
    if (rest.length > 0) {
      out.push({
        key: '__other',
        label: `${rest.length} other customer${rest.length === 1 ? '' : 's'}`,
        values: BUCKET_ORDER.map((b) => rest.reduce((sum, c) => sum + (c.buckets[b]?.balanceCents ?? 0), 0)),
      });
    }
    return out;
  }, [data.customers]);

  const basisMethod = data.agingMethod === 'INVOICE_DATE' ? 'invoice date' : 'due date';

  return (
    <>
      <ChartCard
        eyebrow="AR aging"
        title="Who owes what, by age"
        basis={`Open invoices at ${data.asOf}, aged by ${basisMethod} · the top bar is the mix of all receivables`}
        period={`At ${data.asOf}`}
        summary={summarizeAging(AGING_BUCKETS, rows, { overdueFrom: 1 })}
        legend={agingLegend(AGING_BUCKETS)}
        table={agingTable(AGING_BUCKETS, rows, 'AR aging by customer', 'Customer', 'All open AR')}
        drillHint="Click a customer’s bar to open their invoices"
        onRowDrill={onDrill}
        height={Math.max(160, (rows.length + 1) * 36 + 32)}
        state={total > 0 ? undefined : { kind: 'empty', title: 'No open receivables', body: 'Nothing is outstanding in this scope.' }}
      >
        <AgingBars buckets={AGING_BUCKETS} rows={rows} totalLabel="All open AR" onDrill={(r) => onDrill(r)} ariaLabel="AR aging by customer" />
      </ChartCard>

      <div className={s.buckets} aria-label="Aging buckets">
        {BUCKET_ORDER.map((b) => (
          <div key={b} className="fig">
            <span className={cx('fig-l', s.bucketHead)}><Pip kind={BUCKET_PIP[b]} />{BUCKET_LABEL[b]}</span>
            <span className="fig-v fig-v--dense tnum">{formatMoney(data.buckets[b].balanceCents)}</span>
            <span className="fig-vs">
              <span className="tnum">{data.buckets[b].count} inv{total > 0 ? ` · ${Math.round((data.buckets[b].balanceCents / total) * 100)}%` : ''}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Last-activity cell ────────────────────────────────────────────────────

function LastActivity({ inv }: { inv: WorklistItem }) {
  const bits: React.ReactNode[] = [];
  if (inv.lastReminderAt) bits.push(<span key="r">Reminded {fmtWhen(inv.lastReminderAt)}{inv.reminderCount > 1 ? ` ×${inv.reminderCount}` : ''}</span>);
  else if (inv.lastSentAt) bits.push(<span key="s" className="ink-2">Sent {fmtWhen(inv.lastSentAt)}{inv.sentCount > 1 ? ` ×${inv.sentCount}` : ''}</span>);
  if (inv.viewCount > 0) bits.push(<span key="v" className="ink-3"><Icon name="eye" size={12} label="Viewed" /> {fmtWhen(inv.lastViewedAt)}{inv.viewCount > 1 ? ` ×${inv.viewCount}` : ''}</span>);
  if (bits.length === 0) return <span className="ink-3">Never contacted</span>;
  return <span className={s.activity}>{bits}</span>;
}

function RemindButton({ inv, onRemind, busy }: {
  inv: WorklistItem; onRemind: (inv: WorklistItem) => void; busy: boolean;
}) {
  const disabled = busy || !inv.customerEmail;
  return (
    <Button
      onClick={(e) => { e.stopPropagation(); onRemind(inv); }}
      disabled={disabled}
      title={inv.customerEmail ? `Email a payment reminder to ${inv.customerEmail}` : 'No customer email on file'}
    >
      {busy ? 'Sending…' : inv.lastReminderAt ? 'Remind again' : 'Send reminder'}
    </Button>
  );
}

function DaysLate({ inv }: { inv: WorklistItem }) {
  return (
    <span className="mb-sev" title={BUCKET_LABEL[inv.bucket]}>
      <Pip kind={BUCKET_PIP[inv.bucket]} />
      <span className="tnum">{inv.daysOverdue}d</span>
    </span>
  );
}

// ─── Worklist table ────────────────────────────────────────────────────────

function Worklist({ rows, onOpen, onRemind, remindingId, keysOn }: {
  rows: WorklistItem[]; onOpen: (id: string) => void;
  onRemind: (inv: WorklistItem) => void; remindingId: string | null; keysOn: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('priority');
  const [dir, setDir] = useState<1 | -1>(-1);
  const [cursor, setCursor] = useState<string | null>(null);
  const sorted = useMemo(() => sortWorklist(rows, sortKey, dir), [rows, sortKey, dir]);
  const rank = useMemo(() => new Map(sorted.map((r, i) => [r.id, i + 1])), [sorted]);

  const toggle = (k: SortKey) => {
    if (k === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setDir(-1); }
  };
  const sortOf = (k: SortKey, label: string) => ({
    direction: sortKey === k ? (dir === 1 ? ('asc' as const) : ('desc' as const)) : null,
    onToggle: () => toggle(k),
    label: `Sort by ${label}`,
  });

  const columns: QueueColumn<WorklistItem>[] = [
    { id: 'rank', header: '#', width: 48, cell: (inv) => <span className="ink-3 tnum">{rank.get(inv.id)}</span> },
    {
      id: 'customer',
      header: 'Customer',
      sort: sortOf('customer', 'customer'),
      cell: (inv) => (
        <>
          <span className="l1">{inv.customerName}</span>
          {inv.locationCode && <span className="l2">{inv.locationCode}</span>}
        </>
      ),
    },
    { id: 'invoice', header: 'Invoice', width: 128, cell: (inv) => <span className="tnum">{inv.invoiceNumber}</span> },
    { id: 'due', header: 'Due', width: 112, sort: sortOf('due', 'due date'), cell: (inv) => <span className="tnum ink-2">{inv.dueDate}</span> },
    { id: 'late', header: 'Days late', width: 112, numeric: true, sort: sortOf('daysOverdue', 'days late'), cell: (inv) => <DaysLate inv={inv} /> },
    { id: 'balance', header: 'Balance', width: 128, numeric: true, sort: sortOf('balance', 'balance'), cell: (inv) => <span className="tnum b">{formatMoney(inv.balanceCents)}</span> },
    { id: 'activity', header: 'Last activity', width: 200, sort: sortOf('priority', 'priority'), cell: (inv) => <LastActivity inv={inv} /> },
    {
      id: 'act',
      header: <span className="sr">Action</span>,
      width: 144,
      numeric: true,
      cell: (inv) => <RemindButton inv={inv} onRemind={onRemind} busy={remindingId === inv.id} />,
    },
  ];

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing overdue"
        description="Every open invoice in this scope is within terms. Check back after the next due date, or widen the company filter."
      />
    );
  }

  return (
    <div>
      <div className={s.tableWrap}>
        <QueueTable<WorklistItem>
          aria-label="Overdue invoices, highest priority first"
          columns={columns}
          rows={sorted}
          getRowId={(inv) => inv.id}
          rowState={(inv) => ({ attn: inv.bucket === '90+' })}
          cursorId={cursor}
          onCursorChange={(id) => setCursor(id)}
          onOpen={(inv) => onOpen(inv.id)}
          openOnClick
          hotkeys={keysOn}
          actions={[{ key: 'r', label: 'Send reminder', run: (rs) => { const inv = rs[0]; if (inv && inv.customerEmail && remindingId !== inv.id) onRemind(inv); } }]}
        />
      </div>
      <Keybar
        hints={[
          { chord: 'j k', label: 'Move' },
          { chord: 'enter', label: 'Open invoice' },
          { chord: 'r', label: 'Send reminder' },
        ]}
        note="Sort by any underlined column."
      />
    </div>
  );
}

// ─── Customer rollup (expandable) ──────────────────────────────────────────

function CustomerTable({ customers, expanded, setExpanded, onOpen, onRemind, remindingId, keysOn }: {
  customers: CustomerRollup[];
  expanded: string | null;
  setExpanded: (key: string | null) => void;
  onOpen: (id: string) => void;
  onRemind: (inv: WorklistItem) => void; remindingId: string | null; keysOn: boolean;
}) {
  // J/K move between customers, Enter opens or closes the customer's invoices.
  const { setActiveIndex, rowProps } = useListKeynav({
    count: customers.length,
    onOpen: (i) => {
      const c = customers[i];
      if (!c) return;
      const key = custKey(c);
      setExpanded(expanded === key ? null : key);
    },
    enabled: keysOn,
    owner: 'Collections by customer',
  });

  if (customers.length === 0) {
    return (
      <EmptyState
        title="No open receivables"
        description="No customer has an outstanding balance in this scope. Pick another company or as-of date."
      />
    );
  }

  return (
    <div>
      <div className={s.tableWrap}>
        <table className="tbl tbl-q" aria-label="Open receivables by customer">
          <colgroup>
            <col />
            <col style={{ width: 128 }} />
            <col style={{ width: 128 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 168 }} />
            <col style={{ width: 144 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col" className="n">Open</th>
              <th scope="col" className="n">Overdue</th>
              <th scope="col" className="n">Oldest</th>
              <th scope="col" className="n">Avg pay</th>
              <th scope="col">Last contact</th>
              <th scope="col" className="n">Invoices</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c, i) => {
              const key = custKey(c);
              const open = expanded === key;
              const { ref, 'data-active': active } = rowProps(i);
              return (
                <React.Fragment key={key}>
                  <tr
                    ref={ref}
                    onClick={() => { setActiveIndex(i); setExpanded(open ? null : key); }}
                    className={cx('q-row', active && 'is-cursor', c.oldestDaysOverdue > 90 && 'is-attn')}
                    aria-current={active ? 'true' : undefined}
                    aria-expanded={open}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <span className={s.toggle}>
                        <Icon name={open ? 'down' : 'right'} />
                        <span className="l1">{c.customerName}</span>
                      </span>
                    </td>
                    <td className="n tnum">{formatMoney(c.openBalanceCents)}</td>
                    <td className="n tnum">{c.overdueBalanceCents > 0 ? formatMoney(c.overdueBalanceCents) : <span className="ink-3">—</span>}</td>
                    <td className="n tnum ink-2">{c.oldestDaysOverdue > 0 ? `${c.oldestDaysOverdue}d` : '—'}</td>
                    <td className="n tnum ink-2">{c.avgDaysToPay != null ? `${c.avgDaysToPay}d` : '—'}</td>
                    <td className="ink-2">{fmtWhenLong(c.lastContactAt) ?? 'Never'}</td>
                    <td className="n tnum ink-2">{c.overdueCount}/{c.invoiceCount} overdue</td>
                  </tr>
                  {open && c.invoices.map((inv) => (
                    <tr
                      key={inv.id}
                      onClick={() => onOpen(inv.id)}
                      className={cx('q-row', s.subRow)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className={s.subFirst}>
                        <span className="tnum">{inv.invoiceNumber}</span>
                        {inv.locationCode && <span className="t-cap"> · {inv.locationCode}</span>}
                      </td>
                      <td className="n tnum">{formatMoney(inv.balanceCents)}</td>
                      <td className="n">
                        {inv.daysOverdue > 0
                          ? <span className="mb-sev"><Pip kind={BUCKET_PIP[inv.bucket]} /><span className="tnum">{inv.daysOverdue}d late</span></span>
                          : <span className="mb-sev"><Pip kind="ready" />Current</span>}
                      </td>
                      <td className="n tnum ink-3">{inv.dueDate}</td>
                      <td />
                      <td><LastActivity inv={inv} /></td>
                      <td className="n">
                        {inv.daysOverdue > 0 && <RemindButton inv={inv} onRemind={onRemind} busy={remindingId === inv.id} />}
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <Keybar
        hints={[
          { chord: 'j k', label: 'Move' },
          { chord: 'enter', label: 'Show or hide invoices' },
        ]}
        note="Click an invoice to open it."
      />
    </div>
  );
}
