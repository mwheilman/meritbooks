'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Bands,
  Button,
  InlineNotice,
  ListPager,
  Pip,
  QueueTable,
  Search,
  Select,
  Tag,
  api,
  money,
  toast,
  useDebounce,
  useQuery,
  type QueueAction,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { useShellLine } from '@/components/layout/shell-context';
import { VendorPanel } from './vendor-panel';
import { VENDOR_TYPE_OPTIONS, outcomeLook, relative, rowLook, type ActionResponse, type Dashboard, type DashboardRow } from './vc-types';
import s from './vendor-compliance.module.css';

type Band = 'all' | 'compliant' | 'expiring' | 'missing' | 'on_hold' | 'review';
const PAGE = 50;

function matchesBand(r: DashboardRow, b: Band): boolean {
  switch (b) {
    case 'compliant':
      return r.compliant;
    case 'expiring':
      return r.expiring;
    case 'missing':
      return r.missing;
    case 'on_hold':
      return r.onHold;
    case 'review':
      return r.pendingReview > 0 || r.bankChangePending;
    default:
      return true;
  }
}

/** One cell per requirement: pip shape + short word, full reason on hover / in the panel. */
export function RequirementStrip({ r }: { r: Pick<DashboardRow, 'rules'> }) {
  if (r.rules.length === 0) return <span className="ink-3">Nothing required</span>;
  return (
    <span className={s.strip}>
      {r.rules.map((c) => {
        const look = outcomeLook(c.outcome);
        return (
          <span key={c.id} className={`${s.cell} t-cap`} title={`${c.label}: ${c.reason}`}>
            <Pip kind={look.pip} />
            {c.label.replace('General liability, ', 'GL ').replace("Workers' compensation", 'WC').replace('Certificate holder', 'Holder')}
          </span>
        );
      })}
    </span>
  );
}

export interface ComplianceTabProps {
  locationId: string | null;
  companyName: string | null;
  refreshKey: number;
  onChanged: () => void;
}

export function ComplianceTab({ locationId, companyName, refreshKey, onChanged }: ComplianceTabProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [band, setBand] = useState<Band>('all');
  const [company, setCompany] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 200).trim().toLowerCase();
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('vendor'));

  const { data, error, isLoading, refetch } = useQuery<Dashboard>('/api/vendor-compliance/dashboard', { location_id: locationId ?? undefined }, { key: String(refreshKey), scope: false });

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    return all.filter(
      (r) =>
        matchesBand(r, band) &&
        (!company || r.companies.some((c) => c.id === company)) &&
        (!type || (type === 'none' ? !r.vendorType : r.vendorType === type)) &&
        (!q || r.vendorName.toLowerCase().includes(q) || (r.email ?? '').toLowerCase().includes(q)),
    );
  }, [data, band, company, type, q]);
  const paged = rows.slice((page - 1) * PAGE, page * PAGE);
  const sum = data?.summary;

  useShellLine(
    sum
      ? [
          { label: `${sum.onHold} on hold`, strong: sum.onHold > 0 },
          sum.blockedBalanceCents > 0 ? `${money(sum.blockedBalanceCents, { symbol: '$' })} of payables held` : 'No payables held',
          sum.pendingReview > 0 ? `${sum.pendingReview} waiting for review` : 'Nothing waiting for review',
        ]
      : null,
    sum ? `${sum.onHold}:${sum.blockedBalanceCents}:${sum.pendingReview}` : 'none',
  );

  const refresh = useCallback(() => {
    void refetch();
    onChanged();
  }, [refetch, onChanged]);

  const requestNow = useCallback(
    async (r: DashboardRow, kind?: 'w9' | 'coi') => {
      const want = kind ?? (r.rules.some((c) => c.id === 'W9' && c.outcome !== 'met' && c.outcome !== 'pending') ? 'w9' : 'coi');
      const res = await api.post<ActionResponse>('/api/vendor-compliance/chase', { action: 'request_now', vendor_id: r.vendorId, kind: want });
      if (res.error) {
        toast.error(res.error.error);
        return;
      }
      toast(res.data?.message ?? 'Requested.');
      refresh();
    },
    [refresh],
  );

  const columns = useMemo<QueueColumn<DashboardRow>[]>(
    () => [
      {
        id: 'status',
        header: 'Status',
        width: 124,
        cell: (r) => {
          const look = rowLook(r);
          return (
            <span className="mb-sev">
              <Pip kind={look.pip} />
              {look.word}
            </span>
          );
        },
      },
      {
        id: 'vendor',
        header: 'Vendor',
        cell: (r) => (
          <>
            <span className="l1">{r.vendorName}</span>
            <span className="l2">{r.headline}</span>
          </>
        ),
      },
      { id: 'reqs', header: 'Requirements', cell: (r) => <RequirementStrip r={r} /> },
      { id: 'expiry', header: 'Next expiry', width: 112, cell: (r) => <span className="tnum ink-2">{r.nextExpiry ?? '—'}</span> },
      {
        id: 'chase',
        header: 'Chase',
        width: 132,
        cell: (r) =>
          r.liveRequest ? (
            <span className="ink-2" title={`Next ask ${r.liveRequest.nextSendAt ?? 'not scheduled'}`}>
              Asked <span className="tnum">{r.liveRequest.sendsCount}</span>× · {r.liveRequest.status === 'snoozed' ? 'snoozed' : relative(r.liveRequest.nextSendAt)}
            </span>
          ) : r.pendingReview > 0 ? (
            <Tag tone="ai">In review</Tag>
          ) : (
            <span className="ink-3">—</span>
          ),
      },
      { id: 'ap', header: 'Open A/P', width: 120, numeric: true, cell: (r) => <span className="tnum">{money(r.openBillsCents)}</span> },
    ],
    [],
  );

  const actions = useMemo<QueueAction<DashboardRow>[]>(
    () => [
      { key: 'r', label: 'Request now', run: (rs) => rs[0] && void requestNow(rs[0]) },
      { key: 'o', label: 'Open', run: (rs) => rs[0] && setSelectedId(rs[0].vendorId) },
    ],
    [requestNow],
  );

  const bandsItems = [
    { value: 'all' as const, label: 'Vendors', count: sum ? sum.total.toLocaleString() : '—', caption: sum ? `${sum.requirementSets} requirement set${sum.requirementSets === 1 ? '' : 's'}` : ' ' },
    { value: 'compliant' as const, label: 'Compliant', count: sum ? sum.compliant.toLocaleString() : '—', caption: 'Everything on file' },
    { value: 'expiring' as const, label: 'Expiring ≤ 30 days', count: sum ? sum.expiring.toLocaleString() : '—', caption: 'Renewal chased automatically' },
    { value: 'missing' as const, label: 'Missing', count: sum ? sum.missing.toLocaleString() : '—', caption: 'Missing, short or expired' },
    { value: 'on_hold' as const, label: 'On hold', count: sum ? sum.onHold.toLocaleString() : '—', caption: sum && sum.blockedBalanceCents > 0 ? `${money(sum.blockedBalanceCents, { symbol: '$' })} held` : 'No payables held' },
    { value: 'review' as const, label: 'Needs a person', count: sum ? (sum.pendingReview + sum.bankChanges).toLocaleString() : '—', caption: 'Uploads + bank changes' },
  ];

  return (
    <div>
      <Bands<Band>
        aria-label="Vendors by compliance state"
        value={band}
        onChange={(b) => {
          setBand(b);
          setPage(1);
        }}
        items={bandsItems}
      />

      {data && !locationId && data.byCompany.length > 1 && (
        <div className={s.companies} role="group" aria-label="By company">
          {data.byCompany.map((c) => (
            <button
              key={c.locationId}
              type="button"
              className={`${s.company} ${company === c.locationId ? s.companyOn : ''}`}
              aria-pressed={company === c.locationId}
              onClick={() => {
                setCompany((cur) => (cur === c.locationId ? null : c.locationId));
                setPage(1);
              }}
            >
              <span className="t-head">{c.name}</span>
              <span className={`${s.companyCounts} t-cap`}>
                <span>
                  <span className="tnum">{c.compliant}</span>/<span className="tnum">{c.total}</span> compliant
                </span>
                {c.onHold > 0 && (
                  <span className="mb-sev">
                    <Pip kind="overdue" />
                    <span className="tnum">{c.onHold}</span> on hold
                  </span>
                )}
                {c.expiring > 0 && (
                  <span className="mb-sev">
                    <Pip kind="risk" />
                    <span className="tnum">{c.expiring}</span> expiring
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className={s.toolbar}>
        <Select aria-label="Vendor type" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} style={{ width: 220 }}>
          <option value="">All vendor types</option>
          {VENDOR_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          <option value="none">Unclassified</option>
        </Select>
        {company && (
          <Button variant="quiet" icon="x" onClick={() => setCompany(null)}>
            {data?.byCompany.find((c) => c.locationId === company)?.name ?? 'Company'}
          </Button>
        )}
        <div className={s.grow} />
        <Search aria-label="Search vendors" placeholder="Search vendor or email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} slashToFocus />
      </div>

      {sum && sum.requirementSets === 0 && (
        <InlineNotice tone="info" title="No requirement sets yet." className="mb-inline-field">
          Holds follow the documents tracked on each vendor. Add a requirement set (Requirements tab) to say what each kind of vendor owes{companyName ? ` ${companyName}` : ''} — limits, endorsements, certificate holder — and the chase asks for exactly that.
        </InlineNotice>
      )}

      <div className={s.split}>
        <div>
          {error ? (
            <div className={s.state} role="alert">
              <p className="t-head">Couldn’t load vendor compliance.</p>
              <p className="ink-2">{error}</p>
              <Button onClick={() => void refetch()}>Try again</Button>
            </div>
          ) : isLoading && !data ? (
            <div className={s.state} role="status">
              <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
              <span className="bar-l" style={{ width: '40%' }} aria-hidden="true" />
              <p className="t-cap">Loading vendors…</p>
            </div>
          ) : rows.length === 0 ? (
            <div className={s.state}>
              {(data?.rows.length ?? 0) === 0 ? (
                <>
                  <p className="t-head">No vendors are tracked yet.</p>
                  <p className="ink-2">Add a requirement set, or a W-9 / certificate on a vendor, and every vendor it applies to shows here with what it owes.</p>
                </>
              ) : (
                <>
                  <p className="t-head">Nothing matches.</p>
                  <p className="ink-2">Try another band, company, type or search.</p>
                </>
              )}
            </div>
          ) : (
            <>
              <QueueTable
                aria-label="Vendors and their compliance"
                columns={columns}
                rows={paged}
                getRowId={(r) => r.vendorId}
                rowState={(r) => ({ attn: rowLook(r).attn, done: r.compliant && !r.expiring })}
                cursorId={selectedId}
                onCursorChange={(id) => setSelectedId(id)}
                onOpen={(r) => setSelectedId(r.vendorId)}
                openOnClick
                actions={actions}
              />
              <ListPager page={page} perPage={PAGE} total={rows.length} onPage={setPage} noun="vendors" />
            </>
          )}
        </div>
        <div className={s.panelWrap}>
          {selectedId ? (
            <VendorPanel
              vendorId={selectedId}
              row={data?.rows.find((r) => r.vendorId === selectedId) ?? null}
              refreshKey={refreshKey}
              onClose={() => {
                setSelectedId(null);
                router.replace('/vendor-compliance');
              }}
              onRequest={(r, k) => void requestNow(r, k)}
              onChanged={refresh}
            />
          ) : (
            <div className={s.state} style={{ width: '100%' }}>
              <p className="t-head">Pick a vendor</p>
              <p className="ink-2">See what it owes against what is on file, every request and upload on its timeline, and act: request now, override a hold, classify it.</p>
              <p className="t-cap" style={{ marginTop: 8 }}>
                J / K to move · R request now · O open
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
