'use client';

/**
 * Vendors & A/P — section ReviewComponent (client). Payables mirror of ar-review.tsx.
 *
 * Pick a SOURCE (sample ERP pull / CSV / manual), we normalize to a proposal, the
 * human reviews (bulk-accept; edit ambiguous), and commit writes real vendors + open
 * bills and foots Σ open A/P to the A/P control (the tie-out lights up). All states,
 * keyboard accessible, tabular-nums, degrade-safe.
 *
 * The shell keys this on the section's `key` ('vendors_ap') and passes the active
 * company. Calls POST /api/onboarding/import/ap (action preview|commit).
 */

import { useCallback, useState } from 'react';
import { Store, UploadCloud, PencilLine, Loader2, CheckCircle2, AlertTriangle, Trash2, Plus } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { api } from '@/lib/api-client';
import { parseCsv, autoMap } from '@/lib/import/csv';
import { getImportType } from '@/lib/import/definitions';
import { SourceTile } from '@/components/onboarding/source-tile';
import { ProposalCard } from '@/components/onboarding/proposal-card';
import { DropZone } from '@/components/onboarding/drop-zone';
import { TieOutBanner } from '@/components/onboarding/tie-out-banner';
import type { ApImportProposal, RawApParty, RawApOpenItem } from '@/lib/onboarding/import/ap';

export interface ApReviewProps {
  companyId: string;
  companyName?: string;
  onCommitted?: (openApCents: number) => void;
}

type SourceKind = 'erp' | 'csv' | 'manual';

interface PreviewResponse {
  ok: boolean;
  connected?: boolean;
  reason?: string;
  proposal?: ApImportProposal;
}
interface CommitResponse {
  ok: boolean;
  insertedVendors: number;
  insertedBills: number;
  skippedBills: number;
  openApCents: number;
  subledgerAttached: boolean;
}

export function ApReviewComponent({ companyId, companyName, onCommitted }: ApReviewProps) {
  const [source, setSource] = useState<SourceKind | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ApImportProposal | null>(null);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<CommitResponse | null>(null);
  const [lastPayload, setLastPayload] = useState<Record<string, unknown> | null>(null);

  const [manualParties, setManualParties] = useState<RawApParty[]>([]);
  const [manualItems, setManualItems] = useState<RawApOpenItem[]>([]);

  const preview = useCallback(async (payload: Record<string, unknown>) => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await api.post<PreviewResponse>('/api/onboarding/import/ap', {
      action: 'preview',
      companyId,
      ...payload,
    });
    setLoading(false);
    if (err) { setError(err.error); return; }
    if (data && data.connected === false) {
      setError(data.reason ?? 'That system is not connected yet. Upload a CSV or enter payables manually.');
      return;
    }
    if (data?.proposal) { setProposal(data.proposal); setLastPayload(payload); }
  }, [companyId]);

  const onErpSample = useCallback(() => {
    setSource('erp');
    void preview({ source: 'erp', erpId: 'quickbooks', useFixture: true });
  }, [preview]);

  const onCsv = useCallback(async (kind: 'vendors' | 'open_ap', files: File[]) => {
    const file = files[0];
    if (!file) return;
    const text = await file.text();
    const { headers, rows } = parseCsv(text);
    const def = getImportType(kind);
    if (!def) return;
    const mapping = autoMap(headers, def.fields);
    setSource('csv');
    if (kind === 'vendors') {
      await preview({ source: 'csv', vendorRows: rows, vendorMapping: mapping });
    } else {
      await preview({ source: 'csv', billRows: rows, billMapping: mapping });
    }
  }, [preview]);

  const onManualPreview = useCallback(() => {
    void preview({ source: 'manual', parties: manualParties, openItems: manualItems });
  }, [preview, manualParties, manualItems]);

  const commit = useCallback(async () => {
    if (!proposal || !lastPayload) return;
    setCommitting(true);
    setError(null);
    const { data, error: err } = await api.post<CommitResponse>('/api/onboarding/import/ap', {
      action: 'commit',
      companyId,
      ...lastPayload,
    });
    setCommitting(false);
    if (err) { setError(err.error); return; }
    if (data?.ok) {
      setCommitted(data);
      onCommitted?.(data.openApCents);
    }
  }, [proposal, lastPayload, companyId, onCommitted]);

  if (committed) {
    return (
      <div className="rounded-2xl border border-brand-500/30 bg-brand-500/[0.05] px-5 py-6 text-center" role="status">
        <CheckCircle2 size={20} className="mx-auto mb-2 text-brand-400" aria-hidden />
        <p className="text-sm font-semibold text-white">Payables imported.</p>
        <p className="mt-2 text-xs text-slate-400">
          {committed.insertedVendors} vendor{committed.insertedVendors === 1 ? '' : 's'} ·{' '}
          {committed.insertedBills} open bill{committed.insertedBills === 1 ? '' : 's'}
          {committed.skippedBills > 0 ? ` · ${committed.skippedBills} already present` : ''}
        </p>
        <p className="mt-3 font-mono text-lg tabular-nums text-white">{formatMoney(committed.openApCents)}</p>
        <p className="mt-1 text-xs text-slate-500">
          {committed.subledgerAttached
            ? 'Tied to your opening trial balance — this foots to the A/P control before go-live.'
            : 'Open A/P recorded. (No opening trial balance to tie to yet — that is fine for a clean start.)'}
        </p>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-400">
          Where do your vendors &amp; open bills live{companyName ? ` for ${companyName}` : ''}? We bring them in and
          foot them to your A/P control — you just confirm.
        </p>
        <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Choose a source for vendors and A/P">
          <SourceTile icon={<Store size={18} />} title="Connected system" subtitle="Pull from QuickBooks/Xero/Sage" selected={false} onSelect={onErpSample} />
          <SourceTile icon={<UploadCloud size={18} />} title="Upload CSV" subtitle="Vendors &amp; open A/P" selected={false} onSelect={() => setSource('csv')} />
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

      {source === 'csv' && !proposal && (
        <div className="grid gap-3 sm:grid-cols-2">
          <DropZone label="Open A/P CSV" hint="vendor, bill #, dates, total, paid" accept=".csv,text/csv" onFiles={(f) => onCsv('open_ap', f)} />
          <DropZone label="Vendors CSV (optional)" hint="richer master data" accept=".csv,text/csv" onFiles={(f) => onCsv('vendors', f)} />
        </div>
      )}

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
          <Loader2 size={16} className="animate-spin" aria-hidden /> Bringing your payables over…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning-fg" role="alert">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> {error}
        </div>
      )}

      {proposal && <ApProposalReview proposal={proposal} committing={committing} onCommit={commit} />}
    </div>
  );
}

function ApProposalReview({ proposal, committing, onCommit }: { proposal: ApImportProposal; committing: boolean; onCommit: () => void }) {
  const empty = proposal.vendors.length === 0 && proposal.bills.length === 0;
  if (empty) {
    return <p className="rounded-xl border border-slate-800 bg-surface-900/60 px-4 py-6 text-center text-sm text-slate-400">Nothing to import from this source yet.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 text-center">
        <Stat label="New vendors" value={String(proposal.newVendors)} />
        <Stat label="Matched" value={String(proposal.matchedVendors)} />
        <Stat label="Open bills" value={String(proposal.openBillCount)} />
      </div>

      <TieOutBanner
        state={proposal.openApCents > 0 ? 'balanced' : 'pending'}
        debitsCents={proposal.openApCents}
        creditsCents={proposal.openApCents}
        note="Σ open A/P — this must foot to your A/P control (2000) before go-live"
      />

      {proposal.dedupeWarnings.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-400">Possible duplicate vendors — worth a look</p>
          {proposal.dedupeWarnings.slice(0, 6).map((w, i) => (
            <ProposalCard key={i} title={`"${w.aName}" ≈ "${w.bName}"`} subtitle={w.reason} confidence="review" />
          ))}
        </div>
      )}

      {proposal.bills.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <caption className="sr-only">Open payables to import</caption>
            <thead>
              <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                <th scope="col" className="px-3 py-2 font-medium">Vendor</th>
                <th scope="col" className="px-3 py-2 font-medium">Bill #</th>
                <th scope="col" className="px-3 py-2 font-medium">Due</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Open balance</th>
              </tr>
            </thead>
            <tbody>
              {proposal.bills.slice(0, 100).map((b, i) => (
                <tr key={i} className={`border-b border-slate-900 ${b.duplicate ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2 text-slate-200">{b.vendorName}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{b.billNumber || '—'}{b.duplicate ? ' · already present' : ''}</td>
                  <td className="px-3 py-2 font-mono text-xs tabular-nums text-slate-400">{b.dueDate}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-100">{formatMoney(b.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {proposal.bills.length > 100 && (
            <p className="px-3 py-2 text-xs text-slate-500">+{proposal.bills.length - 100} more…</p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onCommit}
        disabled={committing}
        className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-brand-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
      >
        {committing ? <><Loader2 size={15} className="animate-spin" aria-hidden /> Importing…</> : <>Accept &amp; import {proposal.openBillCount} payable{proposal.openBillCount === 1 ? '' : 's'}</>}
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

function ManualEntry({
  parties, items, onParties, onItems, onPreview,
}: {
  parties: RawApParty[];
  items: RawApOpenItem[];
  onParties: (v: RawApParty[]) => void;
  onItems: (v: RawApOpenItem[]) => void;
  onPreview: () => void;
}) {
  const [name, setName] = useState('');
  const [docNumber, setDocNumber] = useState('');
  const [date, setDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [total, setTotal] = useState('');

  const addBill = () => {
    const t = Math.round(Number(total.replace(/[$,\s]/g, '')) * 100);
    if (!name.trim() || !date || !dueDate || !Number.isFinite(t) || t <= 0) return;
    onParties([...parties, { name: name.trim() }]);
    onItems([...items, { partyName: name.trim(), docNumber: docNumber.trim(), date, dueDate, totalCents: t }]);
    setDocNumber(''); setTotal('');
  };

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-surface-900/60 p-4">
      <div className="grid gap-2 sm:grid-cols-5">
        <input aria-label="Vendor name" placeholder="Vendor" value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} />
        <input aria-label="Bill number" placeholder="Bill # (optional)" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} className={fieldCls} />
        <input aria-label="Bill date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldCls} />
        <input aria-label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={fieldCls} />
        <input aria-label="Total" inputMode="decimal" placeholder="$ total" value={total} onChange={(e) => setTotal(e.target.value)} className={`${fieldCls} font-mono tabular-nums`} />
      </div>
      <button type="button" onClick={addBill} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
        <Plus size={13} aria-hidden /> Add
      </button>

      {items.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-300">
          {items.map((it, i) => (
            <li key={i} className="flex items-center justify-between rounded border border-slate-800 px-2 py-1">
              <span>{it.partyName}{it.docNumber ? ` · ${it.docNumber}` : ''}</span>
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
        Review {items.length} payable{items.length === 1 ? '' : 's'}
      </button>
    </div>
  );
}

const fieldCls =
  'rounded-lg border border-slate-700 bg-surface-950 px-2.5 py-1.5 text-sm text-white placeholder:text-slate-600 focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40';
