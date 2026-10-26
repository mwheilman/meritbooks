'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  Button,
  Conf,
  Dialog,
  Field,
  Icon,
  InlineNotice,
  Input,
  Keyhints,
  Panel,
  PanelSection,
  QueueTable,
  Select,
  Tag,
  cx,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import { EmptyState, PageHeader } from '@/components/ui';
import { useQuery, addToast } from '@/hooks';
import { BillsTabs } from '../bills-tabs';
import { InboxAddressCard } from '@/components/inbound-email/inbox-address-card';
import s from './intake.module.css';

// ── Shapes mirrored from lib/ap/doc-intelligence ──────────────
interface ExtractedLine {
  description: string;
  quantity: number;
  unitCostCents: number;
  amountCents: number;
  categoryHint: string | null;
  confidence: number;
}
interface ExtractedBill {
  vendorName: string;
  vendorNameConfidence: number;
  invoiceNumber: string | null;
  invoiceNumberConfidence: number;
  invoiceDate: string | null;
  invoiceDateConfidence: number;
  dueDate: string | null;
  dueDateConfidence: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  totalConfidence: number;
  currency: string;
  lines: ExtractedLine[];
  notes: string;
  providerName: string;
  engineVersion: string;
  extractionMs: number;
}
interface InboundMeta {
  from: string;
  subject: string | null;
  receivedAt: string;
  messageId: string | null;
  /** Sender display name (inbound email, migration 183+). */
  fromName?: string | null;
  /** The company address it was sent to (183+). */
  toAddress?: string | null;
  /** The original email kept as a document (183+). */
  emailDocumentId?: string | null;
  /** false = the provider could not verify the sender (SPF/DKIM/DMARC). */
  senderVerified?: boolean | null;
  senderAuth?: string | null;
}
interface DraftProposal {
  extracted: ExtractedBill;
  fileName: string;
  locationId: string;
  suggestedVendorId: string | null;
  suggestedVendorName: string | null;
  vendorMatchConfidence: number | null;
  suggestedAccountId: string | null;
  suggestedAccountLabel: string | null;
  duplicateWarning: string | null;
  /** How the draft entered the queue. Absent (legacy rows) = 'upload'. */
  source?: 'upload' | 'email';
  /** Whether the document was actually read yet. Absent = 'PARSED'. */
  parseState?: 'PARSED' | 'PENDING_PARSE';
  /** Retained source document (documents bucket) — open the original invoice. */
  sourceDocumentId?: string | null;
  /** Present only for email-sourced drafts. */
  inbound?: InboundMeta | null;
}
interface Draft {
  id: string;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  confidence: number | null;
  createdAt: string;
  proposal: DraftProposal;
}

interface LocationOption { id: string; name: string; short_code: string }
interface VendorOption { id: string; name: string; display_name: string | null; default_account_id: string | null }
interface AccountOption { id: string; account_number: string; name: string }

// ── Small presentational helpers ──────────────────────────────

/** AI confidence (0–1) as the kit meter + number. */
function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return <Conf score={pct} label={`AI confidence ${pct} of 100`} />;
}

function readerLabel(d: Draft): string {
  if (d.proposal.parseState === 'PENDING_PARSE') return 'Not read yet';
  return d.proposal.extracted.providerName === 'azure-doc-intelligence' ? 'Azure OCR' : 'AI vision';
}

function centsFromDollarInput(v: string): number {
  const n = Number(v.replace(/[,$\s]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Open the retained source invoice in a new tab via a short-lived signed URL. */
async function openSourceDocument(documentId: string): Promise<void> {
  try {
    const res = await fetch(`/api/documents/${documentId}/signed-url`);
    const data = (await res.json()) as { url?: string; error?: string };
    if (!res.ok || !data.url) {
      addToast('error', data.error ?? 'Could not open the source document.');
      return;
    }
    window.open(data.url, '_blank', 'noopener,noreferrer');
  } catch {
    addToast('error', 'Network error opening the source document.');
  }
}

/** Source tags: distinguishes an emailed invoice from an uploaded one, flags an
 *  unverified sender, one that arrived but hasn't been machine-read yet
 *  (PENDING_PARSE), and a possible duplicate. */
function SourceBadges({ proposal }: { proposal: DraftProposal }) {
  const isEmail = proposal.source === 'email';
  const pending = proposal.parseState === 'PENDING_PARSE';
  return (
    <span className={s.tags}>
      {isEmail ? (
        <Tag
          title={[
            proposal.inbound?.fromName ? `From ${proposal.inbound.fromName}` : proposal.inbound?.from,
            proposal.inbound?.toAddress ? `to ${proposal.inbound.toAddress}` : null,
          ].filter(Boolean).join(' ')}
        >
          Email
        </Tag>
      ) : (
        <Tag>Upload</Tag>
      )}
      {isEmail && proposal.inbound?.senderVerified === false && (
        <Tag
          tone="neg"
          title={`${proposal.inbound.senderAuth ?? 'The sending mail server did not pass SPF, DKIM or DMARC.'} The From address may be forged — confirm the vendor and the bank details before approving.`}
        >
          Sender not verified
        </Tag>
      )}
      {pending && <Tag tone="warn">Not read yet</Tag>}
      {proposal.duplicateWarning && <Tag tone="warn">Possible duplicate</Tag>}
    </span>
  );
}

export function IntakeQueueClient() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const {
    data: draftsResp,
    isLoading,
    error,
    refetch,
  } = useQuery<{ drafts: Draft[] }>('/api/bills/intake-queue?status=PROPOSED');
  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const { data: vendorData } = useQuery<{ data: VendorOption[] }>('/api/vendors?per_page=200');
  const { data: accountData } = useQuery<{ data: AccountOption[] }>('/api/accounts/search');

  const drafts = useMemo(() => draftsResp?.drafts ?? [], [draftsResp]);
  const locations = locData ?? [];
  const vendors = vendorData?.data ?? [];
  const accounts = accountData?.data ?? [];

  const selected = useMemo(() => drafts.find((d) => d.id === selectedId) ?? null, [drafts, selectedId]);

  // Deep link from the inbound email log: /bills/intake-queue?draft=<id> opens that draft.
  const [linkedDraft, setLinkedDraft] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('draft');
    if (id && /^[0-9a-f-]{36}$/i.test(id)) setLinkedDraft(id);
  }, []);
  useEffect(() => {
    if (!linkedDraft || drafts.length === 0) return;
    if (drafts.some((d) => d.id === linkedDraft)) {
      setSelectedId(linkedDraft);
      setCursorId(linkedDraft);
    } else addToast('info', 'That draft has already been reviewed or is no longer in the queue.');
    setLinkedDraft(null);
  }, [linkedDraft, drafts]);

  const locationName = useCallback(
    (id: string) => locations.find((l) => l.id === id)?.name ?? 'Unknown company',
    [locations],
  );

  const afterDisposition = useCallback(() => {
    setSelectedId(null);
    void refetch();
  }, [refetch]);

  const columns = useMemo<QueueColumn<Draft>[]>(
    () => [
      {
        id: 'doc',
        header: 'Document',
        cell: (d) => (
          <>
            <span className="l1">{d.proposal.extracted.vendorName || 'Unknown vendor'}</span>
            <span className="l2" title={d.proposal.fileName}>
              {[locationName(d.proposal.locationId), d.proposal.fileName, readerLabel(d)].join(' · ')}
            </span>
          </>
        ),
      },
      { id: 'source', header: 'Source', width: 176, cell: (d) => <SourceBadges proposal={d.proposal} /> },
      { id: 'conf', header: 'Read', width: 88, cell: (d) => <ConfidenceBar value={d.confidence ?? d.proposal.extracted.totalConfidence} /> },
      { id: 'amount', header: 'Amount', width: 120, numeric: true, cell: (d) => formatMoney(d.proposal.extracted.totalCents) },
    ],
    [locationName],
  );

  return (
    <div className={s.stack}>
      <PageHeader
        title="AP intake"
        description="Drop or receive vendor invoices. Merit reads each one and drafts a bill; you confirm the vendor and GL coding, then approve. Nothing posts to the ledger until you do."
        actions={
          <Button variant="primary" icon="upload" onClick={() => setUploadOpen(true)}>
            Upload invoice
          </Button>
        }
      />

      <BillsTabs />

      {/* Where emailed bills come from (FPB-ap-intake). */}
      <InboxAddressCard purpose="ap" variant="compact" />

      <div className={s.split}>
        {/* Queue list */}
        <section className={s.queue} aria-label="Drafts waiting for review">
          <div className={s.queueHead}>
            <span className="eyebrow">Waiting for review</span>
            <span className="tnum b">{isLoading ? '—' : drafts.length}</span>
          </div>

          {isLoading ? (
            <div className={cx('wg-loading', s.skel)} aria-busy="true">
              <span className="bar-l" style={{ width: '80%' }} aria-hidden="true" />
              <span className="bar-l" style={{ width: '65%' }} aria-hidden="true" />
              <span className="bar-l" style={{ width: '72%' }} aria-hidden="true" />
              <span className="t-cap" role="status">Loading the intake queue…</span>
            </div>
          ) : error ? (
            <div className={s.state} role="alert">
              <Tag tone="neg">Not loaded</Tag>
              <p className="t-head">Couldn&apos;t load the queue.</p>
              <p className="ink-2">{error}</p>
              <Button onClick={() => void refetch()}>Try again</Button>
            </div>
          ) : drafts.length === 0 ? (
            <EmptyState
              title="Nothing waiting"
              description="Upload an invoice, or email it to the AP inbox above — it appears here as a draft bill to review."
              action={{ label: 'Upload invoice', onClick: () => setUploadOpen(true) }}
            />
          ) : (
            <>
              <div className={s.queueScroll}>
                <QueueTable<Draft>
                  aria-label="Drafts waiting for review"
                  columns={columns}
                  rows={drafts}
                  getRowId={(d) => d.id}
                  rowState={(d) => ({
                    attn: !!d.proposal.duplicateWarning || (d.proposal.source === 'email' && d.proposal.inbound?.senderVerified === false),
                  })}
                  cursorId={cursorId ?? selectedId}
                  onCursorChange={(id) => setCursorId(id)}
                  onOpen={(d) => { setCursorId(d.id); setSelectedId(d.id); }}
                  openOnClick
                  flush
                />
              </div>
              <Keyhints
                className={s.hints}
                hints={[
                  { chord: 'j k', label: 'Move' },
                  { chord: 'enter', label: 'Review draft' },
                ]}
              />
            </>
          )}
        </section>

        {/* Review panel */}
        <div>
          {selected ? (
            <div className={s.panelWrap}>
              <ReviewPanel
                key={selected.id}
                draft={selected}
                companyName={locationName(selected.proposal.locationId)}
                reader={readerLabel(selected)}
                vendors={vendors}
                accounts={accounts}
                onDone={afterDisposition}
                onClose={() => setSelectedId(null)}
              />
            </div>
          ) : (
            <div className={cx('wg-state', s.placeholder)}>
              <span className="wg-empty-mark" aria-hidden="true"><Icon name="file-text" /></span>
              <span className="t-head">Pick a draft to review it side by side</span>
              <p>What AI read on the left, the bill you&apos;ll create on the right. J and K move, Enter opens.</p>
            </div>
          )}
        </div>
      </div>

      {uploadOpen && (
        <UploadModal
          locations={locations}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            void refetch();
          }}
        />
      )}
    </div>
  );
}

// ── Upload modal ──────────────────────────────────────────────
function UploadModal({
  locations,
  onClose,
  onUploaded,
}: {
  locations: LocationOption[];
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(
    async (file: File) => {
      setErr('');
      if (!locationId) {
        setErr('Select a company first.');
        return;
      }
      setBusy(true);
      const fd = new FormData();
      fd.append('file', file);
      fd.append('location_id', locationId);
      try {
        const res = await fetch('/api/bills/intake-queue', { method: 'POST', body: fd });
        const data: unknown = await res.json();
        if (!res.ok) {
          const msg = (data as { error?: string })?.error ?? 'Failed to read document';
          setErr(msg);
          addToast('error', msg);
          setBusy(false);
          return;
        }
        addToast('success', 'Document read — draft added to the queue.');
        onUploaded();
      } catch {
        const msg = 'Network error while uploading the document.';
        setErr(msg);
        addToast('error', msg);
        setBusy(false);
      }
    },
    [locationId, onUploaded],
  );

  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && !busy) void submit(f);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Upload an invoice"
      footNote="Max 10 MB · PDF, PNG, JPG, WebP"
      actions={<Button onClick={onClose}>{busy ? 'Close' : 'Cancel'}</Button>}
    >
      <div className={s.dialogBody}>
        <Field label="Company">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={busy} data-autofocus>
            <option value="">Select…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>

        <button
          type="button"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => fileRef.current?.click()}
          className={cx(s.drop, over && s.dropOver)}
          onDragOver={(e) => { e.preventDefault(); if (!busy) setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          {busy ? (
            <span className="t-head" role="status">Reading the document…</span>
          ) : (
            <>
              <span className={s.dropIcon} aria-hidden="true"><Icon name="file-text" /></span>
              <span className="t-head">Choose a PDF or image</span>
              <span className="t-cap">Or drop it here.</span>
            </>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
          className="sr"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void submit(f);
          }}
        />
        {err && <InlineNotice tone="neg" title="Not uploaded.">{err}</InlineNotice>}
      </div>
    </Dialog>
  );
}

// ── Review panel (side-by-side) ───────────────────────────────
interface EditableLine {
  description: string;
  accountId: string;
  quantity: number;
  amountCents: number;
}

function ReviewPanel({
  draft,
  companyName,
  reader,
  vendors,
  accounts,
  onDone,
  onClose,
}: {
  draft: Draft;
  companyName: string;
  reader: string;
  vendors: VendorOption[];
  accounts: AccountOption[];
  onDone: () => void;
  onClose: () => void;
}) {
  const ex = draft.proposal.extracted;
  const [vendorId, setVendorId] = useState(draft.proposal.suggestedVendorId ?? '');
  const [billNumber, setBillNumber] = useState(ex.invoiceNumber ?? '');
  const [billDate, setBillDate] = useState(ex.invoiceDate ?? new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(ex.dueDate ?? '');
  const [taxDollars, setTaxDollars] = useState((ex.taxCents / 100).toFixed(2));
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  const defaultAccountId = draft.proposal.suggestedAccountId ?? '';
  const seedLines: EditableLine[] =
    ex.lines.length > 0
      ? ex.lines.map((l) => ({
          description: l.description,
          accountId: defaultAccountId,
          quantity: l.quantity > 0 ? l.quantity : 1,
          amountCents: l.amountCents,
        }))
      : [
          {
            description: ex.invoiceNumber ? `Invoice ${ex.invoiceNumber}` : 'Invoice total',
            accountId: defaultAccountId,
            quantity: 1,
            amountCents: ex.totalCents,
          },
        ];
  const [lines, setLines] = useState<EditableLine[]>(seedLines);

  const updateLine = (i: number, patch: Partial<EditableLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const linesTotal = lines.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = centsFromDollarInput(taxDollars);
  const grandTotal = linesTotal + taxCents;

  const canApprove =
    Boolean(vendorId) &&
    Boolean(billDate) &&
    Boolean(dueDate) &&
    lines.length > 0 &&
    lines.every((l) => Boolean(l.accountId));

  const approve = useCallback(async () => {
    if (!canApprove) {
      addToast('error', 'Pick a vendor, a due date, and a GL account for every line.');
      return;
    }
    setBusy('approve');
    // 1) Create the bill via the EXISTING gated route (validation + compliance + GL).
    const body = {
      location_id: draft.proposal.locationId,
      vendor_id: vendorId,
      bill_number: billNumber || undefined,
      bill_date: billDate,
      due_date: dueDate,
      lines: lines.map((l) => ({
        description: l.description || undefined,
        account_id: l.accountId,
        quantity: l.quantity > 0 ? l.quantity : 1,
        unit_cost_cents: Math.max(0, Math.round(l.amountCents / (l.quantity > 0 ? l.quantity : 1))),
        amount_cents: Math.round(l.amountCents),
      })),
      tax_cents: taxCents,
      retainage_pct: 0,
    };
    try {
      const res = await fetch('/api/bills/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        const msg = (data as { error?: string })?.error ?? 'Failed to create the bill';
        addToast('error', msg);
        setBusy(null);
        return;
      }
      const billId = (data as { bill_id?: string })?.bill_id;
      if (!billId) {
        addToast('error', 'Bill created but no id returned; check the Bills list.');
        onDone();
        return;
      }
      // 2) Mark the draft approved + link the bill.
      await fetch(`/api/bills/intake-queue/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', bill_id: billId }),
      });
      addToast('success', 'Bill created and draft cleared.');
      onDone();
    } catch {
      addToast('error', 'Network error while creating the bill.');
      setBusy(null);
    }
  }, [canApprove, draft.id, draft.proposal.locationId, vendorId, billNumber, billDate, dueDate, lines, taxCents, onDone]);

  const reject = useCallback(async () => {
    setBusy('reject');
    try {
      const res = await fetch(`/api/bills/intake-queue/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject' }),
      });
      if (!res.ok) {
        const data: unknown = await res.json();
        addToast('error', (data as { error?: string })?.error ?? 'Failed to reject the draft');
        setBusy(null);
        return;
      }
      addToast('success', 'Draft rejected.');
      onDone();
    } catch {
      addToast('error', 'Network error while rejecting the draft.');
      setBusy(null);
    }
  }, [draft.id, onDone]);

  const fieldRow = (label: string, extractedValue: string, confidence: number, editable: ReactNode) => (
    <div className={s.fieldRow}>
      <div className={s.extracted}>
        <span className="t-cap">{label}</span>
        <span className="l1">{extractedValue || '—'}</span>
        <ConfidenceBar value={confidence} />
      </div>
      <div>{editable}</div>
    </div>
  );

  const isEmail = draft.proposal.source === 'email';
  const sourceDocumentId = draft.proposal.sourceDocumentId;

  return (
    <Panel
      eyebrow={['Review', companyName]}
      title={ex.vendorName || 'Unknown vendor'}
      meta={`${draft.proposal.fileName} · read by ${reader}`}
      onClose={onClose}
      foot={
        <div className={s.foot}>
          <Button onClick={() => void reject()} disabled={busy !== null} aria-busy={busy === 'reject' || undefined}>
            {busy === 'reject' ? 'Rejecting…' : 'Reject draft'}
          </Button>
          <span />
          <Button
            variant="primary"
            onClick={() => void approve()}
            disabled={busy !== null || !canApprove}
            aria-busy={busy === 'approve' || undefined}
          >
            {busy === 'approve' ? 'Creating bill…' : 'Approve into bill'}
          </Button>
        </div>
      }
    >
      <div className={s.notices}>
        {/* Inbound (email) provenance + source-document access. */}
        {(isEmail || sourceDocumentId) && (
          <InlineNotice tone="info">
            <div className={s.prov}>
              <span>
                {isEmail && draft.proposal.inbound ? (
                  <>
                    Received by email from <b>{draft.proposal.inbound.from}</b>
                    {draft.proposal.inbound.toAddress ? <> to {draft.proposal.inbound.toAddress}</> : null}
                  </>
                ) : (
                  'Uploaded document'
                )}
                {isEmail && draft.proposal.inbound?.subject && (
                  <span className="l2">Subject: {draft.proposal.inbound.subject}</span>
                )}
              </span>
              {sourceDocumentId && (
                <Button icon="eye" onClick={() => void openSourceDocument(sourceDocumentId)}>
                  View original
                </Button>
              )}
            </div>
          </InlineNotice>
        )}

        {isEmail && draft.proposal.inbound?.senderVerified === false && (
          <InlineNotice tone="neg" title="Sender not verified.">
            {draft.proposal.inbound.senderAuth ?? 'The sending mail server did not pass SPF, DKIM or DMARC.'} The From
            address may be forged — confirm the vendor and the bank details before approving.
          </InlineNotice>
        )}

        {/* Degrade-safe state: the document arrived but AI hasn't read it yet. */}
        {draft.proposal.parseState === 'PENDING_PARSE' && (
          <InlineNotice tone="warn" title="Not read yet.">
            This invoice was received and stored, but AI hasn&apos;t read it
            {draft.proposal.extracted.notes ? ` (${draft.proposal.extracted.notes})` : ''}. Open the original
            above and enter the fields to process it now, or leave it here and it will be read once AI is back.
          </InlineNotice>
        )}

        {draft.proposal.duplicateWarning && (
          <InlineNotice tone="warn" title="Possible duplicate.">{draft.proposal.duplicateWarning}</InlineNotice>
        )}
      </div>

      <PanelSection>
        <div className={cx('eyebrow', s.cols)}>
          <span>Read by AI</span>
          <span>Bill to create</span>
        </div>

        {fieldRow(
          'Vendor',
          ex.vendorName,
          ex.vendorNameConfidence,
          <Select aria-label="Vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)} invalid={!vendorId}>
            <option value="">Select vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.display_name ?? v.name}
              </option>
            ))}
          </Select>,
        )}

        {fieldRow(
          'Invoice #',
          ex.invoiceNumber ?? '',
          ex.invoiceNumberConfidence,
          <Input aria-label="Invoice number" className="tnum" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} placeholder="Invoice number" />,
        )}

        {fieldRow(
          'Invoice date',
          ex.invoiceDate ?? '',
          ex.invoiceDateConfidence,
          <Input aria-label="Invoice date" type="date" className="tnum" value={billDate} onChange={(e) => setBillDate(e.target.value)} />,
        )}

        {fieldRow(
          'Due date',
          ex.dueDate ?? '',
          ex.dueDateConfidence,
          <Input aria-label="Due date" type="date" className="tnum" value={dueDate} onChange={(e) => setDueDate(e.target.value)} invalid={!dueDate} />,
        )}
      </PanelSection>

      {/* Lines */}
      <PanelSection title="Line items · GL coding" meta={<span className="t-cap tnum">{lines.length}</span>}>
        {lines.map((l, i) => (
          <div key={i} className={s.lineCard}>
            <div className={s.lineTop}>
              <Input
                aria-label={`Line ${i + 1} description`}
                value={l.description}
                onChange={(e) => updateLine(i, { description: e.target.value })}
                placeholder="Description"
              />
              <span className="tnum b">{formatMoney(l.amountCents)}</span>
            </div>
            <Select
              aria-label={`Line ${i + 1} GL account`}
              value={l.accountId}
              onChange={(e) => updateLine(i, { accountId: e.target.value })}
              invalid={!l.accountId}
            >
              <option value="">Select GL account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.account_number} · {a.name}
                </option>
              ))}
            </Select>
          </div>
        ))}

        {/* Totals */}
        <dl className={s.totals}>
          <dt className="ink-2">Lines subtotal</dt>
          <dd className="tnum">{formatMoney(linesTotal)}</dd>
          <dt className="ink-2">Tax</dt>
          <dd>
            <Input
              aria-label="Tax"
              value={taxDollars}
              onChange={(e) => setTaxDollars(e.target.value)}
              className={cx('input--money', s.taxInput)}
              inputMode="decimal"
            />
          </dd>
          <dt className={s.grand}>Total</dt>
          <dd className={cx('tnum', s.grand)}>{formatMoney(grandTotal)}</dd>
        </dl>
        {grandTotal !== ex.totalCents && (
          <div style={{ marginTop: 8 }}>
            <InlineNotice tone="warn">
              AI read a total of {formatMoney(ex.totalCents)} — your edits changed it.
            </InlineNotice>
          </div>
        )}
        {!canApprove && (
          <p className="t-cap" style={{ marginTop: 8 }}>
            To approve: pick a vendor, a due date, and a GL account for every line.
          </p>
        )}
      </PanelSection>
    </Panel>
  );
}
