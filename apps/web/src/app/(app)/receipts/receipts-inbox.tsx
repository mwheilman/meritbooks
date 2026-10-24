'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Button,
  Icon,
  InlineNotice,
  ListPager,
  Pip,
  QueueTable,
  Search,
  Seg,
  Tag,
  api,
  toast,
  useDebounce,
  useQuery,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { MATCH_LOOK, SOURCE_LABEL, type ReceiptListResponse, type ReceiptListRow, usd } from './receipts-types';
import { ReceiptPanel } from './receipt-panel';
import s from './receipts.module.css';

type MatchFilter = 'all' | 'unmatched' | 'suggested' | 'matched';
const PAGE = 50;

interface UploadResult {
  fileName: string;
  ok: boolean;
  error?: string;
  duplicate?: boolean;
  match?: string;
  merchant?: string | null;
  amountCents?: number | null;
}

export interface ReceiptsInboxProps {
  locationId: string | null;
  companyName: string | null;
  refreshKey: number;
  onChanged: () => void;
}

export function ReceiptsInbox({ locationId, companyName, refreshKey, onChanged }: ReceiptsInboxProps) {
  const [filter, setFilter] = useState<MatchFilter>('all');
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [categorizing, setCategorizing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setPage(1), [filter, q, locationId]);

  const { data, error, isLoading, refetch } = useQuery<ReceiptListResponse>(
    '/api/receipts',
    { match: filter, search: q || undefined, location_id: locationId ?? undefined, page: page > 1 ? String(page) : undefined, per_page: String(PAGE) },
    { key: String(refreshKey), scope: false },
  );
  const rows = useMemo(() => data?.data ?? [], [data]);

  const refresh = useCallback(() => {
    void refetch();
    onChanged();
  }, [refetch, onChanged]);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      if (!locationId) {
        toast.error('Pick a company in the header first — receipts are filed per company.');
        return;
      }
      setUploading(true);
      setResults(null);
      const form = new FormData();
      form.set('location_id', locationId);
      for (const f of list.slice(0, 25)) form.append('files', f);
      try {
        const res = await fetch('/api/receipts/upload', { method: 'POST', body: form });
        const body = (await res.json()) as { results?: UploadResult[]; saved?: number; error?: string };
        if (!res.ok && !body.results) throw new Error(body.error ?? 'Upload failed');
        setResults(body.results ?? []);
        const matched = (body.results ?? []).filter((r) => r.ok && (r.match === 'matched' || r.match === 'attached')).length;
        toast(`${body.saved ?? 0} saved${matched ? `, ${matched} matched to a charge` : ''}.`);
        refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [locationId, refresh],
  );

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files);
  };

  const categorize = async () => {
    setCategorizing(true);
    const res = await api.post<{ ok?: boolean; coded?: number; processed?: number; failed?: number }>('/api/receipts/categorize', { all_pending: true, location_id: locationId ?? undefined });
    setCategorizing(false);
    if (res.error) {
      toast.error(res.status === 402 ? 'AI budget reached — categorization paused.' : res.error.error);
      return;
    }
    const d = res.data;
    toast(d?.coded ? `AI coded ${d.coded} receipt${d.coded === 1 ? '' : 's'}${d.failed ? `, ${d.failed} need you` : ''}.` : 'Nothing to code — no uncoded pending receipts.');
    refresh();
  };

  const approve = async (ids: string[]) => {
    const res = await api.post<{ approved: number; message: string }>('/api/receipts/approve', { receipt_ids: ids });
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    toast(res.data?.message ?? 'Reviewed.');
    setSelected(new Set());
    refresh();
  };

  const columns = useMemo<QueueColumn<ReceiptListRow>[]>(
    () => [
      {
        id: 'match',
        header: 'Match',
        width: 150,
        cell: (r) => (
          <span className="mb-sev">
            <Pip kind={MATCH_LOOK[r.match_status].pip} />
            {MATCH_LOOK[r.match_status].word}
          </span>
        ),
      },
      {
        id: 'receipt',
        header: 'Receipt',
        cell: (r) => (
          <>
            <span className="l1">{r.vendor_name ?? (r.extraction_status === 'pending' ? 'Reading…' : 'Unread receipt')}</span>
            <span className="l2">{[r.receipt_date ?? r.submitted_at.slice(0, 10), SOURCE_LABEL[r.source], r.holder_name, r.location?.short_code].filter(Boolean).join(' · ')}</span>
          </>
        ),
      },
      {
        id: 'charge',
        header: 'Card charge',
        cell: (r) => {
          const c = r.matched_charge ?? r.suggested_charge;
          if (!c) return <span className="ink-3">—</span>;
          return (
            <>
              <span className="l1">{c.description}</span>
              <span className="l2">
                {c.date} · {usd(c.amountCents)}
                {r.suggested_charge && r.match_score != null ? ` · ${Math.round(r.match_score * 100)}% likely` : ''}
              </span>
            </>
          );
        },
      },
      { id: 'amount', header: 'Amount', width: 112, numeric: true, cell: (r) => <span className="tnum">{r.amount_cents != null ? usd(r.amount_cents) : '—'}</span> },
      {
        id: 'flags',
        header: 'Review',
        width: 150,
        cell: (r) => (
          <span>
            {r.flags.includes('amount_differs') && <Tag tone="warn">Amount differs</Tag>}{' '}
            {r.flags.includes('memo_missing') && <Tag tone="warn">Needs a note</Tag>}{' '}
            {r.status === 'APPROVED' && <Tag tone="pos">Reviewed</Tag>}
          </span>
        ),
      },
    ],
    [],
  );

  const counts = data?.counts;
  const open = rows.find((r) => r.id === cursor) ?? null;

  return (
    <div>
      <div
        className={`${s.drop} ${over ? s.dropOver : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        aria-label="Drop receipt files here"
      >
        <span className={s.dropIcon}>
          <Icon name="upload" />
        </span>
        <div>
          <p className="t-head">{uploading ? 'Reading receipts…' : 'Drop receipts here'}</p>
          <p className="t-cap">
            Photos or PDFs, up to 25 at once{companyName ? ` for ${companyName}` : ''}. Each is read, then matched to its card charge — and that charge’s reminders stop.
          </p>
        </div>
        <div className={s.actions}>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf"
            className="sr"
            id="receipt-files"
            onChange={(e) => e.target.files && void upload(e.target.files)}
          />
          <Button variant="primary" icon="upload" disabled={uploading || !locationId} onClick={() => fileRef.current?.click()}>
            Choose files
          </Button>
          <Button variant="quiet" disabled={categorizing} onClick={() => void categorize()}>
            {categorizing ? 'Coding…' : 'AI categorize'}
          </Button>
        </div>
      </div>
      {!locationId && <InlineNotice title="Pick a company in the header to upload.">Receipts are filed per company so they match that company’s card charges.</InlineNotice>}
      {results && results.length > 0 && (
        <ul className={s.results} aria-label="Upload results">
          {results.map((r, i) => (
            <li key={`${r.fileName}-${i}`}>
              <span>
                <b>{r.fileName}</b>{' '}
                <span className="ink-2">{r.ok ? [r.merchant, r.amountCents != null ? usd(r.amountCents) : null].filter(Boolean).join(' · ') : r.error}</span>
              </span>
              <span>{!r.ok ? <Tag tone="neg">Not saved</Tag> : r.duplicate ? <Tag>Already had it</Tag> : r.match === 'matched' || r.match === 'attached' ? <Tag tone="pos">Matched</Tag> : r.match === 'suggested' ? <Tag tone="warn">Confirm match</Tag> : <Tag>No charge yet</Tag>}</span>
            </li>
          ))}
        </ul>
      )}

      <div className={s.toolbar}>
        <Seg<MatchFilter>
          aria-label="Match state"
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All', count: counts?.all },
            { value: 'suggested', label: 'Confirm', count: counts?.suggested },
            { value: 'unmatched', label: 'No charge yet', count: counts?.unmatched },
            { value: 'matched', label: 'Matched', count: counts?.matched },
          ]}
        />
        <div className={s.grow} />
        <Search aria-label="Search receipts" placeholder="Search merchant" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className={s.split}>
        <div>
          {error ? (
            <div className={s.state} role="alert">
              <p className="t-head">Couldn’t load receipts.</p>
              <p className="ink-2">{error}</p>
              <Button onClick={() => void refetch()}>Try again</Button>
            </div>
          ) : isLoading && !data ? (
            <div className={s.state} role="status">
              <p className="t-cap">Loading receipts…</p>
            </div>
          ) : rows.length === 0 ? (
            <div className={s.state}>
              <p className="t-head">{filter === 'all' && !q ? 'No receipts yet.' : 'Nothing matches.'}</p>
              <p className="ink-2">
                {filter === 'all' && !q
                  ? 'Drop files above, or have cardholders snap them in Merit Workforce from their reminder.'
                  : 'Try another filter or clear the search.'}
              </p>
            </div>
          ) : (
            <>
              <QueueTable<ReceiptListRow>
                aria-label="Receipts"
                columns={columns}
                rows={rows}
                getRowId={(r) => r.id}
                rowState={(r) => ({ done: r.status === 'APPROVED', attn: r.match_status === 'suggested' || r.flags.length > 0 })}
                selectable
                selected={selected}
                onSelectedChange={setSelected}
                cursorId={cursor}
                onCursorChange={(id) => setCursor(id)}
                onOpen={(r) => setCursor(r.id)}
                openOnClick
                actions={[{ key: 'a', label: 'Mark reviewed', run: (rs) => void approve(rs.map((r) => r.id)) }]}
                bulkSummary={(rs) => [usd(rs.reduce((n, r) => n + (r.amount_cents ?? 0), 0))]}
                bulkActions={(rs) => (
                  <Button variant="primary" onClick={() => void approve(rs.map((r) => r.id))}>
                    Mark {rs.length} reviewed
                  </Button>
                )}
              />
              {data && <ListPager page={data.pagination.page} perPage={data.pagination.per_page} total={data.pagination.total} noun="receipts" onPage={setPage} />}
            </>
          )}
        </div>
        <div>
          {open ? (
            <ReceiptPanel receiptId={open.id} onClose={() => setCursor(null)} onChanged={refresh} />
          ) : (
            <div className={s.state}>
              <p className="t-head">Pick a receipt</p>
              <p className="ink-2">See the file, what was read, and confirm or change its card charge. X selects · A marks reviewed.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
