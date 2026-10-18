'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  Upload,
  FileText,
  Loader2,
  X,
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Cpu,
  Bot,
  Mail,
  Clock,
  ExternalLink,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { BillsTabs } from '../bills-tabs';

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
function confidenceTone(c: number): string {
  if (c >= 0.85) return 'text-emerald-400';
  if (c >= 0.6) return 'text-amber-400';
  return 'text-red-400';
}
function confidenceBarTone(c: number): string {
  if (c >= 0.85) return 'bg-emerald-500';
  if (c >= 0.6) return 'bg-amber-500';
  return 'bg-red-500';
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 rounded-full bg-slate-800 overflow-hidden">
        <div className={clsx('h-full rounded-full', confidenceBarTone(value))} style={{ width: `${pct}%` }} />
      </div>
      <span className={clsx('text-[11px] font-mono tabular-nums', confidenceTone(value))}>{pct}%</span>
    </div>
  );
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

/** Small source chip: distinguishes an emailed invoice from an uploaded one, and
 *  flags one that arrived but hasn't been machine-read yet (PENDING_PARSE). */
function SourceBadges({ proposal }: { proposal: DraftProposal }) {
  const isEmail = proposal.source === 'email';
  const pending = proposal.parseState === 'PENDING_PARSE';
  if (!isEmail && !pending) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {isEmail && (
        <span className="inline-flex items-center gap-1 rounded-full border border-indigo-800/60 bg-indigo-950/40 px-2 py-0.5 text-[10px] text-indigo-300">
          <Mail size={10} /> Email
        </span>
      )}
      {pending && (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-800/60 bg-amber-950/40 px-2 py-0.5 text-[10px] text-amber-300">
          <Clock size={10} /> Awaiting AI parse
        </span>
      )}
    </div>
  );
}

export function IntakeQueueClient() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const drafts = draftsResp?.drafts ?? [];
  const locations = locData ?? [];
  const vendors = vendorData?.data ?? [];
  const accounts = accountData?.data ?? [];

  const selected = useMemo(() => drafts.find((d) => d.id === selectedId) ?? null, [drafts, selectedId]);

  const locationName = useCallback(
    (id: string) => locations.find((l) => l.id === id)?.name ?? 'Unknown company',
    [locations],
  );

  const afterDisposition = useCallback(() => {
    setSelectedId(null);
    void refetch();
  }, [refetch]);

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <Bot size={20} className="text-indigo-400" />
            <h1 className="text-xl font-semibold text-white">AP Intake Queue</h1>
          </div>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Drop or receive vendor invoices — the machine reads each one and drafts a bill for your
            review. You confirm the vendor and GL coding, then approve. Nothing posts to the ledger
            until you do.
          </p>
        </div>
        <button
          onClick={() => setUploadOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white"
        >
          <Upload size={16} /> Upload document
        </button>
      </div>

      <div className="mb-6">
        <BillsTabs />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
        {/* Queue list */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs uppercase tracking-wide text-slate-500 font-medium px-1">
            <span>Waiting for review</span>
            <span className="text-slate-400">{drafts.length}</span>
          </div>

          {isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-24 rounded-xl bg-slate-900 border border-slate-800 animate-pulse" />
              ))}
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-300">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle size={16} /> Couldn&apos;t load the queue
              </div>
              <p className="mt-1 text-red-400/80">{error}</p>
              <button onClick={() => void refetch()} className="mt-2 text-xs underline text-red-300">
                Retry
              </button>
            </div>
          ) : drafts.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center">
              <Inbox size={28} className="mx-auto text-slate-600" />
              <p className="mt-3 text-sm text-slate-400">No documents waiting.</p>
              <p className="text-xs text-slate-500 mt-1">
                Upload an invoice and it will appear here as a draft.
              </p>
            </div>
          ) : (
            drafts.map((d) => {
              const ex = d.proposal.extracted;
              const conf = d.confidence ?? ex.totalConfidence;
              return (
                <button
                  key={d.id}
                  onClick={() => setSelectedId(d.id)}
                  className={clsx(
                    'w-full text-left rounded-xl border p-4 transition-colors',
                    selectedId === d.id
                      ? 'border-emerald-600 bg-slate-900'
                      : 'border-slate-800 bg-slate-900 hover:border-slate-700',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        {ex.vendorName || 'Unknown vendor'}
                      </p>
                      <p className="text-xs text-slate-500 truncate">{locationName(d.proposal.locationId)}</p>
                    </div>
                    <span className="font-mono text-sm text-white tabular-nums shrink-0">
                      {formatMoney(ex.totalCents)}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <ConfidenceBar value={conf} />
                    <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                      <Cpu size={11} />
                      {d.proposal.parseState === 'PENDING_PARSE'
                        ? 'Not read yet'
                        : ex.providerName === 'azure-doc-intelligence'
                          ? 'Azure OCR'
                          : 'AI vision'}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500 truncate">
                    <FileText size={11} /> {d.proposal.fileName}
                  </div>
                  <SourceBadges proposal={d.proposal} />
                  {d.proposal.duplicateWarning && (
                    <div className="mt-2 flex items-center gap-1 text-[11px] text-amber-400">
                      <AlertTriangle size={11} /> Possible duplicate
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Review panel */}
        <div>
          {selected ? (
            <ReviewPanel
              key={selected.id}
              draft={selected}
              vendors={vendors}
              accounts={accounts}
              onDone={afterDisposition}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 h-full min-h-[400px] flex flex-col items-center justify-center text-center p-8">
              <Sparkles size={28} className="text-slate-600" />
              <p className="mt-3 text-sm text-slate-400">Select a draft to review it side by side.</p>
              <p className="text-xs text-slate-500 mt-1">
                Extracted fields on the left, the bill you&apos;ll create on the right.
              </p>
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <Upload size={16} className="text-emerald-400" />
            <h2 className="text-base font-semibold text-white">Upload invoice</h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-5 p-6">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Company</label>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              <option value="">Select...</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-700 bg-slate-950/40 py-10 text-slate-400 hover:border-emerald-600 hover:text-emerald-300 disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 size={22} className="animate-spin" />
                <span className="text-sm">Reading the document…</span>
              </>
            ) : (
              <>
                <FileText size={22} />
                <span className="text-sm">Choose a PDF or image</span>
                <span className="text-[11px] text-slate-500">Max 10MB · PDF, PNG, JPG, WebP</span>
              </>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void submit(f);
            }}
          />
          {err && <p className="text-xs text-red-400">{err}</p>}
        </div>
      </div>
    </div>
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
  vendors,
  accounts,
  onDone,
  onClose,
}: {
  draft: Draft;
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

  const fieldRow = (label: string, extractedValue: string, confidence: number, editable: React.ReactNode) => (
    <div className="grid grid-cols-2 gap-4 py-2 border-b border-slate-800/60">
      <div>
        <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
        <p className="text-sm text-slate-300 mt-0.5">{extractedValue || '—'}</p>
        <div className="mt-1">
          <ConfidenceBar value={confidence} />
        </div>
      </div>
      <div className="flex items-center">{editable}</div>
    </div>
  );

  const inputCls = 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-white';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-indigo-400" />
            <h2 className="text-base font-semibold text-white">Review extracted bill</h2>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{draft.proposal.fileName}</p>
        </div>
        <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close">
          <X size={18} />
        </button>
      </div>

      {/* Inbound (email) provenance + source-document access. */}
      {(draft.proposal.source === 'email' || draft.proposal.sourceDocumentId) && (
        <div className="mx-5 mt-4 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-slate-400">
              {draft.proposal.source === 'email' ? <Mail size={13} className="shrink-0 text-indigo-400" /> : <FileText size={13} className="shrink-0" />}
              <span className="truncate">
                {draft.proposal.source === 'email' && draft.proposal.inbound
                  ? <>Received by email from <span className="text-slate-200">{draft.proposal.inbound.from}</span></>
                  : 'Uploaded document'}
              </span>
            </div>
            {draft.proposal.sourceDocumentId && (
              <button
                onClick={() => void openSourceDocument(draft.proposal.sourceDocumentId!)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
              >
                <ExternalLink size={11} /> View original
              </button>
            )}
          </div>
          {draft.proposal.source === 'email' && draft.proposal.inbound?.subject && (
            <p className="mt-1 truncate text-slate-500">Subject: {draft.proposal.inbound.subject}</p>
          )}
        </div>
      )}

      {/* Degrade-safe state: the document arrived but AI hasn't read it yet. */}
      {draft.proposal.parseState === 'PENDING_PARSE' && (
        <div className="mx-5 mt-4 flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2.5 text-xs text-amber-300">
          <Clock size={14} className="mt-0.5 shrink-0" />
          <span>
            Awaiting AI parse — this invoice was received and stored, but hasn&apos;t been read yet
            {draft.proposal.extracted.notes ? ` (${draft.proposal.extracted.notes})` : ''}. Open the
            original above and enter the fields to process it now, or leave it here and the machine
            will read it once AI is back.
          </span>
        </div>
      )}

      {draft.proposal.duplicateWarning && (
        <div className="mx-5 mt-4 flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{draft.proposal.duplicateWarning}</span>
        </div>
      )}

      <div className="px-5 py-4">
        <div className="grid grid-cols-2 gap-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          <span className="flex items-center gap-1">
            <Bot size={12} /> Extracted (AI)
          </span>
          <span>Bill to create</span>
        </div>

        {fieldRow(
          'Vendor',
          ex.vendorName,
          ex.vendorNameConfidence,
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={inputCls}>
            <option value="">Select vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.display_name ?? v.name}
              </option>
            ))}
          </select>,
        )}

        {fieldRow(
          'Invoice #',
          ex.invoiceNumber ?? '',
          ex.invoiceNumberConfidence,
          <input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} className={inputCls} placeholder="Invoice number" />,
        )}

        {fieldRow(
          'Invoice date',
          ex.invoiceDate ?? '',
          ex.invoiceDateConfidence,
          <input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} className={inputCls} />,
        )}

        {fieldRow(
          'Due date',
          ex.dueDate ?? '',
          ex.dueDateConfidence,
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />,
        )}

        {/* Lines */}
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Line items · GL coding</p>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <input
                    value={l.description}
                    onChange={(e) => updateLine(i, { description: e.target.value })}
                    className="flex-1 bg-transparent text-sm text-white outline-none"
                    placeholder="Description"
                  />
                  <span className="font-mono text-sm text-white tabular-nums">{formatMoney(l.amountCents)}</span>
                </div>
                <select
                  value={l.accountId}
                  onChange={(e) => updateLine(i, { accountId: e.target.value })}
                  className={clsx(inputCls, 'mt-2', !l.accountId && 'border-amber-700')}
                >
                  <option value="">Select GL account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.account_number} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        {/* Totals */}
        <div className="mt-4 space-y-1.5 text-sm">
          <div className="flex items-center justify-between text-slate-400">
            <span>Lines subtotal</span>
            <span className="font-mono tabular-nums text-slate-200">{formatMoney(linesTotal)}</span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span>Tax</span>
            <input
              value={taxDollars}
              onChange={(e) => setTaxDollars(e.target.value)}
              className="w-28 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-right font-mono text-sm text-white"
              inputMode="decimal"
            />
          </div>
          <div className="flex items-center justify-between border-t border-slate-800 pt-2 text-white">
            <span className="font-medium">Total</span>
            <span className="font-mono tabular-nums font-semibold">{formatMoney(grandTotal)}</span>
          </div>
          {grandTotal !== ex.totalCents && (
            <p className="text-[11px] text-amber-400">
              Extracted total was {formatMoney(ex.totalCents)} — your edits changed it.
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-4">
        <button
          onClick={() => void reject()}
          disabled={busy !== null}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          onClick={() => void approve()}
          disabled={busy !== null || !canApprove}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy === 'approve' ? (
            <>
              <Loader2 size={15} className="animate-spin" /> Creating bill…
            </>
          ) : (
            <>
              <CheckCircle2 size={15} /> Approve into bill
            </>
          )}
        </button>
      </div>
    </div>
  );
}
