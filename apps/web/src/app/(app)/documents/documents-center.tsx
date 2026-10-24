'use client';

/**
 * DOCUMENTS — every stored file, what it is, and where it went (FPB-document-intelligence §8;
 * merit-ui v2.3, cockpit density).
 *
 *   Bands       All · Needs review · Proposals ready · Unfiled
 *   Each row    type (AI tag when AI typed it) · confidence · company · linked records /
 *               proposals ("Lease proposal") · status ("Needs review · AI later")
 *   Panel       what it is (other party, key dates, amount, summary), correct the type /
 *               company, open each proposal in its module, link to an existing record,
 *               read again, dismiss, view / download / delete
 *   Header      Upload (we work out the type) · Analyze existing documents (the backfill)
 *   AI down     an AiPaused notice says what still works: rules typed them, AI re-reads later
 *
 * States: loading, empty, filtered-empty, error, populated. Server-side pagination.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AiPaused,
  Bands,
  Button,
  Conf,
  InlineNotice,
  ListPager,
  PageHead,
  QueueTable,
  Search,
  Select,
  Status,
  Tag,
  api,
  toast,
  useDebounce,
  useQuery,
  type QueueAction,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { DOC_TYPES, DOC_TYPE_LABEL, MAX_DOCUMENT_BYTES, entityTypeLabel, formatBytes, type DocType } from '@/lib/documents/schema';
import { TARGETS } from '@/lib/documents/intelligence/types';
import { openDocument } from '@/components/documents/intelligence-client';
import { DocumentPanel } from './document-panel';
import {
  fmtDate,
  statusOf,
  typeLabel,
  type AnalyzeResponse,
  type Band,
  type CenterRow,
  type DocListResponse,
  type IntelResponse,
  type LocationOption,
} from './documents-types';
import s from './documents.module.css';

type DatePreset = 'ALL' | '7D' | '30D' | '90D' | 'YTD';
const DATE_PRESETS: Array<{ value: DatePreset; label: string }> = [
  { value: 'ALL', label: 'Any date' },
  { value: '7D', label: 'Last 7 days' },
  { value: '30D', label: 'Last 30 days' },
  { value: '90D', label: 'Last 90 days' },
  { value: 'YTD', label: 'This year' },
];
const PER_PAGE = 50;

function presetToDateFrom(p: DatePreset): string | undefined {
  if (p === 'ALL') return undefined;
  const now = new Date();
  if (p === 'YTD') return new Date(now.getFullYear(), 0, 1).toISOString();
  const days = p === '7D' ? 7 : p === '30D' ? 30 : 90;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function DocumentsCenter() {
  const [band, setBand] = useState<Band>('all');
  const [rawSearch, setRawSearch] = useState('');
  const search = useDebounce(rawSearch, 300);
  const [typeFilter, setTypeFilter] = useState<DocType | 'ALL'>('ALL');
  const [datePreset, setDatePreset] = useState<DatePreset>('ALL');
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [uploadType, setUploadType] = useState<DocType | 'AUTO'>('AUTO');
  const [working, setWorking] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Deep link from a module banner: /documents?doc=<id>.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('doc');
    if (id) setOpenId(id);
  }, []);
  useEffect(() => setPage(1), [band, search, typeFilter, datePreset]);

  // Bands backed by intelligence state: fetch the ids first.
  const bandStatus = band === 'review' ? 'needs_review' : band === 'proposals' ? 'proposal_created' : null;
  const { data: bandIntel } = useQuery<IntelResponse>(bandStatus ? '/api/documents/intelligence' : null, { status: bandStatus ?? undefined }, { key: `b:${refreshKey}`, scope: false });
  const bandIds = bandStatus ? (bandIntel ? bandIntel.data.map((r) => r.document_id) : null) : undefined;

  const listParams = {
    page: String(page),
    per_page: String(PER_PAGE),
    search: search.trim() || undefined,
    doc_type: typeFilter !== 'ALL' ? typeFilter : undefined,
    date_from: presetToDateFrom(datePreset),
    linked: band === 'unfiled' ? 'unfiled' : undefined,
    ids: bandIds === undefined ? undefined : (bandIds ?? []).join(','),
  };
  const listReady = bandIds !== null;
  const { data: list, error: listError, isLoading } = useQuery<DocListResponse>(listReady ? '/api/documents' : null, listParams, { key: `l:${refreshKey}`, scope: false });
  // The ids param must be sent even when empty (an empty band shows nothing).
  const docs = useMemo(() => (bandIds && bandIds.length === 0 ? [] : list?.data ?? []), [list, bandIds]);
  const docIds = docs.map((d) => d.id).join(',');

  const { data: intel, error: intelError } = useQuery<IntelResponse>('/api/documents/intelligence', { document_ids: docIds || undefined }, { key: `i:${refreshKey}:${docIds}`, scope: false });
  const { data: locData } = useQuery<LocationOption[]>('/api/locations', undefined, { scope: false });
  const locations = useMemo(() => locData ?? [], [locData]);
  const locName = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations]);
  const summary = intel?.summary;

  const rows: CenterRow[] = useMemo(() => {
    const byDoc = new Map((intel?.data ?? []).map((i) => [i.document_id, i]));
    return docs.map((doc) => ({
      doc,
      intel: byDoc.get(doc.id) ?? null,
      proposals: (intel?.proposals ?? []).filter((p) => p.document_id === doc.id),
      links: (intel?.links ?? []).filter((l) => l.document_id === doc.id),
    }));
  }, [docs, intel]);

  // Keep the open document's row even when it is not on this page (deep link).
  const { data: openList } = useQuery<DocListResponse>(openId && !rows.some((r) => r.doc.id === openId) ? '/api/documents' : null, { ids: openId ?? '' }, { key: `o:${refreshKey}:${openId}`, scope: false });
  const { data: openIntel } = useQuery<IntelResponse>(openId && !rows.some((r) => r.doc.id === openId) ? '/api/documents/intelligence' : null, { document_ids: openId ?? '' }, { key: `oi:${refreshKey}:${openId}`, scope: false });
  const openRow: CenterRow | null = useMemo(() => {
    if (!openId) return null;
    const here = rows.find((r) => r.doc.id === openId);
    if (here) return here;
    const doc = openList?.data?.[0];
    if (!doc) return null;
    return {
      doc,
      intel: openIntel?.data?.[0] ?? null,
      proposals: (openIntel?.proposals ?? []).filter((p) => p.document_id === doc.id),
      links: (openIntel?.links ?? []).filter((l) => l.document_id === doc.id),
    };
  }, [openId, rows, openList, openIntel]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const analyzeOne = useCallback(async (id: string, force = false): Promise<string | null> => {
    const r = await api.post<AnalyzeResponse>('/api/documents/intelligence/analyze', { document_id: id, force });
    if (r.error) return r.error.error;
    return r.data?.message ?? null;
  }, []);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const uploaded: Array<{ id: string; name: string }> = [];
    for (const [i, file] of list.entries()) {
      setWorking(`Uploading ${i + 1} of ${list.length}…`);
      if (file.size > MAX_DOCUMENT_BYTES) {
        toast.error(`${file.name} is over the 25 MB limit.`);
        continue;
      }
      const fd = new FormData();
      fd.append('file', file);
      if (uploadType !== 'AUTO') fd.append('doc_type', uploadType);
      const res = await fetch('/api/documents', { method: 'POST', body: fd });
      const body = (await res.json().catch(() => null)) as { document?: { id: string; file_name: string }; error?: string } | null;
      if (!res.ok || !body?.document) {
        toast.error(body?.error ?? `Couldn’t upload ${file.name}.`);
        continue;
      }
      uploaded.push({ id: body.document.id, name: body.document.file_name });
    }
    if (inputRef.current) inputRef.current.value = '';
    bump();
    // Read each one and route it (proposals only).
    for (const [i, u] of uploaded.entries()) {
      setWorking(`Reading ${i + 1} of ${uploaded.length}: ${u.name}`);
      const msg = await analyzeOne(u.id);
      if (msg) toast(`${u.name}: ${msg}`);
    }
    setWorking(null);
    if (uploaded.length) bump();
  }

  async function backfill() {
    setWorking('Analyzing existing documents…');
    const r = await api.post<{ message: string; result: { remaining: number } }>('/api/documents/intelligence/analyze', { all: true, limit: 25 });
    setWorking(null);
    if (r.error) {
      toast.error(r.error.error);
      return;
    }
    setBackfillNote(r.data?.message ?? null);
    bump();
  }

  async function analyzeSelected(ids: string[]) {
    for (const [i, id] of ids.entries()) {
      setWorking(`Reading ${i + 1} of ${ids.length}…`);
      const msg = await analyzeOne(id, true);
      if (msg && ids.length === 1) toast(msg);
    }
    setWorking(null);
    setSelected(new Set());
    if (ids.length > 1) toast(`Read ${ids.length} documents.`);
    bump();
  }

  async function downloadSelected(ids: string[]) {
    let failed = 0;
    for (const id of ids) {
      const e = await openDocument(id, 'download');
      if (e) failed++;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (failed) toast.error(`${failed} could not be downloaded.`);
  }

  // ── Table ──────────────────────────────────────────────────────────────────
  const columns: QueueColumn<CenterRow>[] = [
    {
      id: 'doc',
      header: 'Document',
      cell: (r) => (
        <span>
          <b className={s.name}>{r.doc.file_name}</b>
          <span className="t-cap">
            {formatBytes(r.doc.size_bytes)} // {fmtDate(r.doc.created_at)}
          </span>
        </span>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      width: 170,
      cell: (r) => <Tag tone={r.intel?.class_source === 'ai' ? 'ai' : 'default'}>{typeLabel(r)}</Tag>,
    },
    {
      id: 'conf',
      header: 'Confidence',
      width: 110,
      cell: (r) => (r.intel && r.intel.class_source !== 'user' && Number(r.intel.confidence) > 0 ? <Conf score={Math.round(Number(r.intel.confidence) * 100)} /> : <span className="t-cap">{r.intel?.class_source === 'user' ? 'You' : '—'}</span>),
    },
    {
      id: 'company',
      header: 'Company',
      width: 160,
      cell: (r) => <span className="t-cap">{r.intel?.location_id ? (locName.get(r.intel.location_id) ?? '—') : '—'}</span>,
    },
    {
      id: 'linked',
      header: 'Linked to',
      cell: (r) => {
        const pend = r.proposals.filter((p) => p.status === 'pending' && p.mode !== 'route');
        if (r.links.length === 0 && pend.length === 0) {
          return <span className="t-cap">{r.doc.entity_type && r.doc.entity_type !== 'location' ? entityTypeLabel(r.doc.entity_type) : 'Unfiled'}</span>;
        }
        return (
          <span className={s.links}>
            {r.links.slice(0, 2).map((l) => (
              <span key={l.id} className="t-cap">{l.label ?? entityTypeLabel(l.target_type)}</span>
            ))}
            {r.links.length > 2 && <span className="t-cap">+{r.links.length - 2}</span>}
            {pend.map((p) => (
              <Tag key={p.id} tone="ai">{`${TARGETS[p.target_kind].noun[0].toUpperCase()}${TARGETS[p.target_kind].noun.slice(1)} proposal`}</Tag>
            ))}
          </span>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      width: 190,
      cell: (r) => {
        const st = statusOf(r);
        return <Status kind={st.kind}>{st.word}</Status>;
      },
    },
  ];

  const actions: QueueAction<CenterRow>[] = [
    { key: 'v', label: 'View', run: (rs) => rs[0] && void openDocument(rs[0].doc.id).then((e) => e && toast.error(e)) },
    { key: 'r', label: 'Read again', run: (rs) => void analyzeSelected(rs.map((r) => r.doc.id)) },
  ];

  const total = bandIds && bandIds.length === 0 ? 0 : list?.pagination.total ?? 0;
  const hasFilters = !!search || typeFilter !== 'ALL' || datePreset !== 'ALL';
  const error = listError ?? intelError;
  const deferred = summary?.ai_deferred ?? 0;
  const notAnalyzed = summary?.not_analyzed ?? 0;

  return (
    <div>
      <PageHead
        eyebrow={['Records', 'Documents']}
        title="Documents"
        actions={
          <>
            <Button variant="quiet" icon="history" onClick={backfill} disabled={working !== null}>
              Analyze existing documents{notAnalyzed > 0 ? ` (${notAnalyzed})` : ''}
            </Button>
            <Button variant="primary" icon="upload" onClick={() => inputRef.current?.click()} disabled={working !== null}>
              Upload
            </Button>
          </>
        }
      >
        <p className="t-cap">
          Every stored file in one place. Drop anything — a lease, loan, policy, W-9, bill or contract — and we work out what it is, which company it belongs to, and put a proposal in the module that uses it. Nothing is set up or posted until a person reviews it there.
        </p>
      </PageHead>

      <input ref={inputRef} type="file" multiple hidden onChange={(e) => void onFiles(e.target.files)} aria-label="Choose files to upload" />

      <div
        className={`${s.drop} ${dragOver ? s.dropOver : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void onFiles(e.dataTransfer.files);
        }}
      >
        <span className={s.dropIcon} aria-hidden="true">
          <Button iconOnly icon="upload" aria-label="Upload" onClick={() => inputRef.current?.click()} />
        </span>
        <span className="t-body">{working ?? 'Drop files here. PDFs, images, spreadsheets, Word — up to 25 MB each.'}</span>
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="t-cap">Type</span>
          <Select value={uploadType} onChange={(e) => setUploadType(e.target.value as DocType | 'AUTO')} aria-label="Type for uploads">
            <option value="AUTO">Work it out for me</option>
            {DOC_TYPES.filter((t) => t !== 'OTHER').map((t) => (
              <option key={t} value={t}>
                {DOC_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {deferred > 0 && (
        <AiPaused title="AI reading paused for some documents">
          {deferred} document{deferred === 1 ? ' was' : 's were'} typed by file name and text rules. We’ll read {deferred === 1 ? 'it' : 'them'} again automatically every 15 minutes — or set the type yourself.
        </AiPaused>
      )}
      {backfillNote && (
        <InlineNotice tone="info" title="Analysis finished.">
          {backfillNote}
        </InlineNotice>
      )}

      <Bands<Band>
        aria-label="Documents"
        value={band}
        onChange={setBand}
        items={[
          { value: 'all', label: 'All', count: band === 'all' ? total : '·', caption: 'Every stored file' },
          { value: 'review', label: 'Needs review', count: summary?.needs_review ?? '·', caption: 'We couldn’t tell what it is' },
          { value: 'proposals', label: 'Proposals ready', count: summary?.proposals_pending ?? '·', caption: 'Waiting in a module for review' },
          { value: 'unfiled', label: 'Unfiled', count: band === 'unfiled' ? total : '·', caption: 'Not linked to a record' },
        ]}
      />

      <div className={s.toolbar}>
        <div className={s.grow}>
          <Search aria-label="Search file names" slashToFocus value={rawSearch} onChange={(e) => setRawSearch(e.target.value)} placeholder="Search file names" />
        </div>
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as DocType | 'ALL')} aria-label="Filter by type">
          <option value="ALL">All types</option>
          {DOC_TYPES.map((t) => (
            <option key={t} value={t}>
              {DOC_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        <Select value={datePreset} onChange={(e) => setDatePreset(e.target.value as DatePreset)} aria-label="Filter by upload date">
          {DATE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
        {hasFilters && (
          <Button
            variant="quiet"
            icon="x"
            onClick={() => {
              setRawSearch('');
              setTypeFilter('ALL');
              setDatePreset('ALL');
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className={openRow ? s.split : undefined}>
        <div>
          {error ? (
            <div className={s.state}>
              <InlineNotice tone="neg" title="Couldn’t load documents.">
                {error}
              </InlineNotice>
              <Button onClick={bump}>Try again</Button>
            </div>
          ) : (isLoading || !listReady) && docs.length === 0 ? (
            <div className={s.state}>
              <p className="t-cap">Loading documents…</p>
            </div>
          ) : docs.length === 0 ? (
            <div className={s.state}>
              <b className="t-body">
                {hasFilters ? 'No documents match these filters.' : band === 'review' ? 'Nothing needs review.' : band === 'proposals' ? 'No proposals waiting.' : band === 'unfiled' ? 'Everything is filed.' : 'No documents yet.'}
              </b>
              <p className="t-cap">
                {hasFilters
                  ? 'Clear the filters to see everything.'
                  : band === 'all'
                    ? 'Upload a lease, loan agreement, insurance policy, W-9, bill or contract — we’ll work out where it belongs.'
                    : 'When a document needs you, it shows up here.'}
              </p>
            </div>
          ) : (
            <>
              <QueueTable<CenterRow>
                aria-label="Documents"
                columns={columns}
                rows={rows}
                getRowId={(r) => r.doc.id}
                rowState={(r) => ({ attn: r.intel?.status === 'needs_review', done: r.intel?.status === 'dismissed' || r.intel?.status === 'duplicate' })}
                selectable
                selected={selected}
                onSelectedChange={setSelected}
                cursorId={openId}
                onCursorChange={(id) => id && setOpenId(id)}
                onOpen={(r) => setOpenId(r.doc.id)}
                openOnClick
                actions={actions}
                bulkSummary={(rs) => [`${rs.length} selected`, formatBytes(rs.reduce((n, r) => n + (r.doc.size_bytes ?? 0), 0))]}
                bulkActions={(rs) => (
                  <>
                    <Button onClick={() => void downloadSelected(rs.map((r) => r.doc.id))}>Download</Button>
                    <Button variant="primary" onClick={() => void analyzeSelected(rs.map((r) => r.doc.id))} disabled={working !== null}>
                      Read again
                    </Button>
                  </>
                )}
              />
              <ListPager page={page} perPage={PER_PAGE} total={total} onPage={setPage} noun="documents" />
            </>
          )}
        </div>
        {openRow && (
          <DocumentPanel
            key={openRow.doc.id}
            row={openRow}
            locations={locations}
            onClose={() => setOpenId(null)}
            onChanged={bump}
            onDeleted={() => {
              setOpenId(null);
              bump();
            }}
          />
        )}
      </div>
    </div>
  );
}
