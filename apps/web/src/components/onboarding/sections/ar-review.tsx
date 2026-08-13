'use client';

/**
 * Customers & A/R — section ReviewComponent (client).
 *
 * The "review, don't enter" surface for the receivables domain: pick a SOURCE
 * (sample ERP pull / CSV upload / manual), we normalize it to a proposal, the human
 * reviews (bulk-accept; edit ambiguous), and commit writes real customers + opening
 * invoices and foots Σ open A/R to the A/R control (the tie-out lights up).
 *
 * All states: source / loading / empty / populated / error / committed. Keyboard
 * accessible, numbers tabular-nums. Degrade-safe (works with AI off).
 *
 * The generic shell keys this on the section's `key` ('customers_ar') and passes the
 * active company. It calls POST /api/onboarding/import/ar (action preview|commit).
 */

import { useCallback, useState } from 'react';
import { Users, UploadCloud, PencilLine, Loader2, CheckCircle2, AlertTriangle, Trash2, Plus } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { api } from '@/lib/api-client';
import { parseCsv, autoMap } from '@/lib/import/csv';
import { getImportType } from '@/lib/import/definitions';
import { SourceTile } from '@/components/onboarding/source-tile';
import { ProposalCard } from '@/components/onboarding/proposal-card';
import { DropZone } from '@/components/onboarding/drop-zone';
import { TieOutBanner } from '@/components/onboarding/tie-out-banner';
import type { ArImportProposal, RawArParty, RawArOpenItem } from '@/lib/onboarding/import/ar';

export interface ArReviewProps {
  /** The company (location) these receivables belong to. */
  companyId: string;
  companyName?: string;
  /** Fired after a successful commit with the committed Σ open A/R (cents). */
  onCommitted?: (openArCents: number) => void;
}

type SourceKind = 'erp' | 'csv' | 'manual';

interface PreviewResponse {
  ok: boolean;
  connected?: boolean;
  reason?: string;
  proposal?: ArImportProposal;
}
interface CommitResponse {
  ok: boolean;
  insertedCustomers: number;
  insertedInvoices: number;
  skippedInvoices: number;
  openArCents: number;
  subledgerAttached: boolean;
}

export function ArReviewComponent({ companyId, companyName, onCommitted }: ArReviewProps) {
  const [source, setSource] = useState<SourceKind | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ArImportProposal | null>(null);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<CommitResponse | null>(null);
  // The exact source payload behind the current proposal — resent verbatim on commit
  // (so a CSV import stays lossless: the parsed rows/mapping are re-sent, not dropped).
  const [lastPayload, setLastPayload] = useState<Record<string, unknown> | null>(null);

  // Manual entry state.
  const [manualParties, setManualParties] = useState<RawArParty[]>([]);
  const [manualItems, setManualItems] = useState<RawArOpenItem[]>([]);

  const preview = useCallback(async (payload: Record<string, unknown>) => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await api.post<PreviewResponse>('/api/onboarding/import/ar', {
      action: 'preview',
      companyId,
      ...payload,
    });
    setLoading(false);
    if (err) { setError(err.error); return; }
    if (data && data.connected === false) {
      setError(data.reason ?? 'That system is not connected yet. Upload a CSV or enter receivables manually.');
      return;
    }
    if (data?.proposal) { setProposal(data.proposal); setLastPayload(payload); }
  }, [companyId]);

  const onErpSample = useCallback(() => {
    setSource('erp');
    void preview({ source: 'erp', erpId: 'quickbooks', useFixture: true });
  }, [preview]);

  const onCsv = useCallback(async (kind: 'customers' | 'open_ar', files: File[]) => {
    const file = files[0];
    if (!file) return;
    const text = await file.text();
    const { headers, rows } = parseCsv(text);
    const def = getImportType(kind);
    if (!def) return;
    const mapping = autoMap(headers, def.fields);
    setSource('csv');
    if (kind === 'customers') {
      await preview({ source: 'csv', customerRows: rows, customerMapping: mapping });
    } else {
      await preview({ source: 'csv', invoiceRows: rows, invoiceMapping: mapping });
    }
  }, [preview]);

  const onManualPreview = useCallback(() => {
    void preview({ source: 'manual', parties: manualParties, openItems: manualItems });
  }, [preview, manualParties, manualItems]);

  const commit = useCallback(async () => {
    if (!proposal || !lastPayload) return;
    setCommitting(true);
    setError(null);
    // Resend the SAME source payload that produced this proposal (lossless for CSV).
    const { data, error: err } = await api.post<CommitResponse>('/api/onboarding/import/ar', {
      action: 'commit',
      companyId,
      ...lastPayload,
    });
    setCommitting(false);
    if (err) { setError(err.error); return; }
    if (data?.ok) {
      setCommitted(data);
      onCommitted?.(data.openArCents);
    }
  }, [proposal, lastPayload, companyId, onCommitted]);

  // ── Committed ────────────────────────────────────────────────────────────────
  if (committed) {
    return (
      <div className="rounded-2xl border border-brand-500/30 bg-brand-500/[0.05] px-5 py-6 text-center" role="status">
        <CheckCircle2 size={20} className="mx-auto mb-2 text-brand-400" aria-hidden />
        <p className="text-sm font-semibold text-white">Receivables imported.</p>
        <p className="mt-2 text-xs text-slate-400">
          {committed.insertedCustomers} customer{committed.insertedCustomers === 1 ? '' : 's'} ·{' '}
          {committed.insertedInvoices} open invoice{committed.insertedInvoices === 1 ? '' : 's'}
          {committed.skippedInvoices > 0 ? ` · ${committed.skippedInvoices} already present` : ''}
        </p>
        <p className="mt-3 font-mono text-lg tabular-nums text-white">{formatMoney(committed.openArCents)}</p>
        <p className="mt-1 text-xs text-slate-500">
          {committed.subledgerAttached
            ? 'Tied to your opening trial balance — this foots to the A/R control before go-live.'
            : 'Open A/R recorded. (No opening trial balance to tie to yet — that is fine for a clean start.)'}
        </p>
      </div>
    );
  }

  // ── Source picker ──────────────────────────────────────────────────────────────
  if (!source) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-400">
          Where do your customers &amp; open receivables live{companyName ? ` for ${companyName}` : ''}? We bring them
          in and foot them to your A/R control — you just confirm.
        </p>
        <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Choose a source for customers and A/R">
          <SourceTile icon={<Users size={18} />} title="Connected system" subtitle="Pull from QuickBooks/Xero/Sage" selected={false} onSelect={onErpSample} />
          <SourceTile icon={<UploadCloud size={18} />} title="Upload CSV" subtitle="Customers &amp; open A/R" selected={false} onSelect={() => setSource('csv')} />
          <SourceTile icon={<PencilLine size={18} />} title="Enter manually" subtitle="Add a few by hand" selected={false} onSelect={() => setSource('manual')} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => { setSource(null); setProposal(null); setError(null); }}
        className="text-xs text-slate-500 hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 rounded"
      >
        ← Choose a different source
      </button>

      {/* CSV inputs */}
      {source === 'csv' && !proposal && (
        <div className="grid gap-3 sm:grid-cols-2">
          <DropZone label="Open A/R CSV" hint="customer, invoice #, dates, total, paid" accept=".csv,text/csv" onFiles={(f) => onCsv('open_ar', f)} />
          <DropZone label="Customers CSV (optional)" hint="richer master data" accept=".csv,text/csv" onFiles={(f) => onCsv('customers', f)} />
        </div>
      )}

      {/* Manual inputs */}
      {source === 'manual' && !proposal && (
        <ManualEntry
          parties={manualParties}
          items={manualItems}
          onParties={setManualParties}
          onItems={setManualItems}
          onPreview={onManualPreview}
        />
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-surface-900/60 px-5 py-8 text-sm text-slate-400" role="status" aria-live="polite">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Bringing your receivables over…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning-fg" role="alert">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> {error}
        </div>
      )}

      {proposal && <ArProposalReview proposal={proposal} committing={committing} onCommit={commit} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposal review
// ─────────────────────────────────────────────────────────────────────────────

function ArProposalReview({ proposal, committing, onCommit }: { proposal: ArImportProposal; committing: boolean; onCommit: () => void }) {
  const empty = proposal.customers.length === 0 && proposal.invoices.length === 0;
  if (empty) {
    return <p className="rounded-xl border border-slate-800 bg-surface-900/60 px-4 py-6 text-center text-sm text-slate-400">Nothing to import from this source yet.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 text-center">
        <Stat label="New customers" value={String(proposal.newCustomers)} />
        <Stat label="Matched" value={String(proposal.matchedCustomers)} />
        <Stat label="Open invoices" value={String(proposal.openInvoiceCount)} />
      </div>

      <TieOutBanner
        state={proposal.openArCents > 0 ? 'balanced' : 'pending'}
        debitsCents={proposal.openArCents}
        creditsCents={proposal.openArCents}
        note="Σ open A/R — this must foot to your A/R control (1100) before go-live"
      />

      {proposal.dedupeWarnings.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-400">Possible duplicate customers — worth a look</p>
          {proposal.dedupeWarnings.slice(0, 6).map((w, i) => (
            <ProposalCard key={i} title={`"${w.aName}" ≈ "${w.bName}"`} subtitle={w.reason} confidence="review" />
          ))}
        </div>
      )}

      {proposal.invoices.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <caption className="sr-only">Open receivables to import</caption>
            <thead>
              <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                <th scope="col" className="px-3 py-2 font-medium">Customer</th>
                <th scope="col" className="px-3 py-2 font-medium">Invoice #</th>
                <th scope="col" className="px-3 py-2 font-medium">Due</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Open balance</th>
              </tr>
            </thead>
            <tbody>
              {proposal.invoices.slice(0, 100).map((inv, i) => (
                <tr key={i} className={`border-b border-slate-900 ${inv.duplicate ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2 text-slate-200">{inv.customerName}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{inv.invoiceNumber}{inv.duplicate ? ' · already present' : ''}</td>
                  <td className="px-3 py-2 font-mono text-xs tabular-nums text-slate-400">{inv.dueDate}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-100">{formatMoney(inv.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {proposal.invoices.length > 100 && (
            <p className="px-3 py-2 text-xs text-slate-500">+{proposal.invoices.length - 100} more…</p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onCommit}
        disabled={committing}
        className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-brand-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
      >
        {committing ? <><Loader2 size={15} className="animate-spin" aria-hidden /> Importing…</> : <>Accept &amp; import {proposal.openInvoiceCount} receivable{proposal.openInvoiceCount === 1 ? '' : 's'}</>}
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-surface-900/60 px-3 py-2.5">
      <p className="font-mono text-lg tabular-nums text-white">{value}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal manual entry (one customer + one open invoice at a time)
// ─────────────────────────────────────────────────────────────────────────────

function ManualEntry({
  parties, items, onParties, onItems, onPreview,
}: {
  parties: RawArParty[];
  items: RawArOpenItem[];
  onParties: (v: RawArParty[]) => void;
  onItems: (v: RawArOpenItem[]) => void;
  onPreview: () => void;
}) {
  const [name, setName] = useState('');
  const [docNumber, setDocNumber] = useState('');
  const [date, setDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [total, setTotal] = useState('');

  const addInvoice = () => {
    const t = Math.round(Number(total.replace(/[$,\s]/g, '')) * 100);
    if (!name.trim() || !docNumber.trim() || !date || !dueDate || !Number.isFinite(t) || t <= 0) return;
    onParties([...parties, { name: name.trim() }]);
    onItems([...items, { partyName: name.trim(), docNumber: docNumber.trim(), date, dueDate, totalCents: t }]);
    setDocNumber(''); setTotal('');
  };

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-surface-900/60 p-4">
      <div className="grid gap-2 sm:grid-cols-5">
        <input aria-label="Customer name" placeholder="Customer" value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} />
        <input aria-label="Invoice number" placeholder="Invoice #" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} className={fieldCls} />
        <input aria-label="Invoice date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldCls} />
        <input aria-label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={fieldCls} />
        <input aria-label="Total" inputMode="decimal" placeholder="$ total" value={total} onChange={(e) => setTotal(e.target.value)} className={`${fieldCls} font-mono tabular-nums`} />
      </div>
      <button type="button" onClick={addInvoice} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
        <Plus size={13} aria-hidden /> Add
      </button>

      {items.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-300">
          {items.map((it, i) => (
            <li key={i} className="flex items-center justify-between rounded border border-slate-800 px-2 py-1">
              <span>{it.partyName} · {it.docNumber}</span>
              <span className="flex items-center gap-2">
                <span className="font-mono tabular-nums">{formatMoney(it.totalCents)}</span>
                <button type="button" aria-label="Remove" onClick={() => { onItems(items.filter((_, j) => j !== i)); onParties(parties.filter((_, j) => j !== i)); }} className="text-slate-500 hover:text-red-400">
                  <Trash2 size={13} aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <button type="button" onClick={onPreview} disabled={items.length === 0} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-brand-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
        Review {items.length} receivable{items.length === 1 ? '' : 's'}
      </button>
    </div>
  );
}

const fieldCls =
  'rounded-lg border border-slate-700 bg-surface-950 px-2.5 py-1.5 text-sm text-white placeholder:text-slate-600 focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40';
