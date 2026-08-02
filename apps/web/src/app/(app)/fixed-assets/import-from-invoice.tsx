'use client';

/**
 * Add-from-invoice: DROP-AND-PARSE a capex invoice into the fixed-asset register.
 *
 * Flow: drop an equipment/capex invoice → the AI (via the metered gateway) extracts
 * the asset(s) and PROPOSES a class + useful life + book method + capitalize-vs-
 * expense hint → the human reviews/edits every field and confirms → the asset is
 * created via the gated create path (posts the acquisition GL + starts depreciation).
 *
 * The model never writes anything: this UI only ever POSTs (a) the file to parse
 * and (b) an explicit, human-confirmed asset. Manual entry stays the fallback (the
 * existing registry create path is untouched).
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import {
  UploadCloud, Loader2, X, FileText, Sparkles, AlertTriangle, CheckCircle2, Info, ChevronDown, Search,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';

// ── Types mirroring the parse API's ProposedAsset ────────────────────────────
interface ProposedAsset {
  vendorName: string | null;
  name: string;
  rawAssetType: string | null;
  serialNumber: string | null;
  quantity: number;
  costCents: number | null;
  unitCostCents: number | null;
  purchaseDate: string | null;
  inServiceDate: string | null;
  proposedCategory: string;
  proposedClassLabel: string;
  usefulLifeMonths: number;
  depreciationMethod: string;
  capitalizationThresholdCents: number;
  belowCapitalizationThreshold: boolean;
  suggestExpense: boolean;
  snippet: string | null;
  notes: string | null;
  lowConfidenceFields: string[];
}

interface ParseResponse {
  assets: ProposedAsset[];
  meta: { fileName: string; model: string; decisionId: string | null; documentNote: string | null; extractionMs: number; assetCount: number };
}

interface LocationOption { id: string; name: string; short_code: string }
interface AccountOption { id: string; accountNumber: string; name: string; accountType: string; isActive: boolean; approvalStatus: string }

const CATEGORY_OPTIONS = ['COMPUTER', 'SOFTWARE', 'VEHICLE', 'FURNITURE', 'MACHINERY', 'EQUIPMENT', 'LEASEHOLD', 'BUILDING', 'OTHER'];
const METHOD_OPTIONS: { value: string; label: string }[] = [
  { value: 'STRAIGHT_LINE', label: 'Straight-line' },
  { value: 'DOUBLE_DECLINING', label: 'Double-declining (200% DB)' },
  { value: 'UNITS_OF_PRODUCTION', label: 'Units of production' },
];
const RAIL_OPTIONS: { value: string; label: string }[] = [
  { value: 'ach', label: 'Paid — bank / ACH' },
  { value: 'check', label: 'Paid — check' },
  { value: 'wire', label: 'Paid — wire' },
  { value: 'credit_card', label: 'Paid — credit card' },
  { value: 'cash', label: 'Paid — cash' },
];
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,image/png,image/jpeg,image/webp';

const todayIso = () => new Date().toISOString().slice(0, 10);
const centsToInput = (c: number | null) => (c == null ? '' : centsToDollars(c).toFixed(2));

// ── Editable per-asset draft state ───────────────────────────────────────────
interface AssetDraft {
  key: string;
  name: string;
  category: string;
  costInput: string;
  salvageInput: string;
  usefulLifeMonths: string;
  method: string;
  acquisitionDate: string;
  rail: string;
  locationId: string;
  assetAccountId: string;
  depExpenseAccountId: string;
  accumDepAccountId: string;
  serialNumber: string | null;
  proposedClassLabel: string;
  suggestExpense: boolean;
  thresholdCents: number;
  lowConfidenceFields: string[];
  saving: boolean;
  done: boolean;
}

function toDraft(a: ProposedAsset, i: number, defaultLocationId: string): AssetDraft {
  return {
    key: `${i}-${a.name}-${a.costCents ?? 'x'}`,
    name: a.name,
    category: a.proposedCategory,
    costInput: centsToInput(a.costCents),
    salvageInput: '0.00',
    usefulLifeMonths: String(a.usefulLifeMonths),
    method: a.depreciationMethod,
    acquisitionDate: a.inServiceDate ?? a.purchaseDate ?? todayIso(),
    rail: 'ach',
    locationId: defaultLocationId,
    assetAccountId: '',
    depExpenseAccountId: '',
    accumDepAccountId: '',
    serialNumber: a.serialNumber,
    proposedClassLabel: a.proposedClassLabel,
    suggestExpense: a.suggestExpense,
    thresholdCents: a.capitalizationThresholdCents,
    lowConfidenceFields: a.lowConfidenceFields,
    saving: false,
    done: false,
  };
}

// ── Inline account picker (searches this company's approved COA) ─────────────
function AccountPicker({
  value, label, accounts, onChange, placeholder,
}: {
  value: string;
  label: string;
  accounts: AccountOption[];
  onChange: (id: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const selected = accounts.find((a) => a.id === value);
  const q = search.trim().toLowerCase();
  const filtered = q
    ? accounts.filter((a) => a.accountNumber.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    : accounts;

  return (
    <div ref={ref} className="relative">
      <label className="block text-2xs uppercase text-slate-500 mb-1">{label}</label>
      <button type="button" onClick={() => setOpen(!open)}
        className={clsx('w-full text-left px-2 py-1.5 rounded-lg border text-xs truncate relative',
          selected ? 'bg-slate-800 border-slate-700 text-white' : 'bg-slate-800/50 border-slate-700/50 text-slate-500')}>
        {selected ? `${selected.accountNumber} · ${selected.name}` : placeholder}
        <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500" />
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="p-2 border-b border-slate-800">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." autoFocus
                className="w-full pl-7 pr-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50" />
            </div>
          </div>
          <div className="max-h-44 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-slate-500 text-center">{accounts.length === 0 ? 'Select a company first' : 'No matches'}</p>
            ) : filtered.slice(0, 30).map((a) => (
              <button key={a.id} type="button" onClick={() => { onChange(a.id); setOpen(false); setSearch(''); }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 flex items-center gap-2">
                <span className="font-mono text-slate-500 w-12 shrink-0">{a.accountNumber}</span>
                <span className="text-slate-300 truncate">{a.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── One editable asset review card ───────────────────────────────────────────
function AssetCard({
  draft, locations, onPatch, onConfirm, onDismiss,
}: {
  draft: AssetDraft;
  locations: LocationOption[];
  onPatch: (patch: Partial<AssetDraft>) => void;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loadingAccts, setLoadingAccts] = useState(false);

  // Load this company's approved chart when a location is chosen.
  useEffect(() => {
    if (!draft.locationId) { setAccounts([]); return; }
    let alive = true;
    setLoadingAccts(true);
    fetch(`/api/accounts?location_id=${draft.locationId}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d) => { if (alive) setAccounts((d.data ?? []) as AccountOption[]); })
      .catch(() => alive && setAccounts([]))
      .finally(() => alive && setLoadingAccts(false));
    return () => { alive = false; };
  }, [draft.locationId]);

  const usable = useMemo(() => accounts.filter((a) => a.isActive && a.approvalStatus === 'APPROVED'), [accounts]);
  const assetAccounts = useMemo(() => usable.filter((a) => a.accountType === 'ASSET'), [usable]);
  const expenseAccounts = useMemo(() => usable.filter((a) => a.accountType === 'OPEX' || a.accountType === 'COGS'), [usable]);

  const costCents = dollarsToCents(Number(String(draft.costInput).replace(/[$,\s]/g, '')) || 0);
  const lifeMonths = Number(draft.usefulLifeMonths);
  const isLow = (f: string) => draft.lowConfidenceFields.includes(f);

  const canConfirm =
    !draft.saving && draft.name.trim() !== '' && costCents > 0 && Number.isInteger(lifeMonths) && lifeMonths > 0 &&
    !!draft.locationId && !!draft.assetAccountId && !!draft.depExpenseAccountId && !!draft.accumDepAccountId;

  if (draft.done) {
    return (
      <div className="card p-4 border border-emerald-500/30 bg-emerald-500/5 flex items-center gap-2">
        <CheckCircle2 size={16} className="text-emerald-400" />
        <span className="text-sm text-emerald-300">{draft.name} added to the register.</span>
      </div>
    );
  }

  const fieldCls = (low: boolean) =>
    clsx('w-full px-2 py-1.5 rounded-lg text-xs text-white font-mono bg-slate-800 border',
      low ? 'border-amber-500/50' : 'border-slate-700');

  return (
    <div className="card p-4 space-y-3">
      {/* Header: AI proposal summary */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles size={13} className="text-indigo-400 shrink-0" />
            <span className="text-2xs uppercase text-indigo-300/80">Proposed: {draft.proposedClassLabel}</span>
          </div>
          {draft.serialNumber && <p className="text-2xs text-slate-500 mt-0.5">Serial / VIN: <span className="font-mono">{draft.serialNumber}</span></p>}
        </div>
        <button onClick={onDismiss} className="text-slate-500 hover:text-slate-300 text-2xs">Dismiss</button>
      </div>

      {/* Capitalize-vs-expense hint */}
      {draft.suggestExpense && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
          <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-2xs text-amber-200/90">
            This cost is below the {formatMoney(draft.thresholdCents)} capitalization threshold — many books would EXPENSE it
            rather than capitalize. Confirm only if your policy capitalizes assets this size.
          </p>
        </div>
      )}

      {/* Name */}
      <div>
        <label className="block text-2xs uppercase text-slate-500 mb-1">Asset name</label>
        <input type="text" value={draft.name} onChange={(e) => onPatch({ name: e.target.value })}
          className={clsx('w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border', isLow('name') ? 'border-amber-500/50' : 'border-slate-700')} />
      </div>

      {/* Class / life / method */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-2xs uppercase text-slate-500 mb-1">Class</label>
          <select value={draft.category} onChange={(e) => onPatch({ category: e.target.value })}
            className={clsx('w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border', isLow('proposedCategory') ? 'border-amber-500/50' : 'border-slate-700')}>
            {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-2xs uppercase text-slate-500 mb-1">Life (months)</label>
          <input type="number" min="1" step="1" value={draft.usefulLifeMonths} onChange={(e) => onPatch({ usefulLifeMonths: e.target.value })}
            className={fieldCls(false)} />
        </div>
        <div>
          <label className="block text-2xs uppercase text-slate-500 mb-1">Method</label>
          <select value={draft.method} onChange={(e) => onPatch({ method: e.target.value })}
            className="w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border border-slate-700">
            {METHOD_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
      </div>

      {/* Cost / salvage / date */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-2xs uppercase text-slate-500 mb-1">Cost ($)</label>
          <input type="number" min="0" step="0.01" value={draft.costInput} onChange={(e) => onPatch({ costInput: e.target.value })}
            placeholder="0.00" className={fieldCls(isLow('costCents'))} />
        </div>
        <div>
          <label className="block text-2xs uppercase text-slate-500 mb-1">Salvage ($)</label>
          <input type="number" min="0" step="0.01" value={draft.salvageInput} onChange={(e) => onPatch({ salvageInput: e.target.value })}
            className={fieldCls(false)} />
        </div>
        <div>
          <label className="block text-2xs uppercase text-slate-500 mb-1">In-service date</label>
          <input type="date" value={draft.acquisitionDate} onChange={(e) => onPatch({ acquisitionDate: e.target.value })}
            className={clsx('w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border', isLow('purchaseDate') ? 'border-amber-500/50' : 'border-slate-700')} />
        </div>
      </div>

      {/* Company + rail */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-2xs uppercase text-slate-500 mb-1">Company</label>
          <select value={draft.locationId}
            onChange={(e) => onPatch({ locationId: e.target.value, assetAccountId: '', depExpenseAccountId: '', accumDepAccountId: '' })}
            className="w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border border-slate-700">
            <option value="">Select company…</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-2xs uppercase text-slate-500 mb-1">How it was paid</label>
          <select value={draft.rail} onChange={(e) => onPatch({ rail: e.target.value })}
            className="w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border border-slate-700">
            {RAIL_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
      </div>

      {/* GL accounts (resolved by explicit pick — the engine never guesses) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <AccountPicker label="Fixed-asset account" placeholder={loadingAccts ? 'Loading…' : 'Pick asset acct'}
          accounts={assetAccounts} value={draft.assetAccountId} onChange={(id) => onPatch({ assetAccountId: id })} />
        <AccountPicker label="Depreciation expense" placeholder={loadingAccts ? 'Loading…' : 'Pick expense acct'}
          accounts={expenseAccounts} value={draft.depExpenseAccountId} onChange={(id) => onPatch({ depExpenseAccountId: id })} />
        <AccountPicker label="Accum. depreciation" placeholder={loadingAccts ? 'Loading…' : 'Pick contra-asset'}
          accounts={assetAccounts} value={draft.accumDepAccountId} onChange={(id) => onPatch({ accumDepAccountId: id })} />
      </div>

      {/* Preview + confirm */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-2xs text-slate-500">
          {costCents > 0 ? <>Capitalize <span className="font-mono text-slate-300">{formatMoney(costCents)}</span> · {formatMoney(costCents)} ÷ {lifeMonths || '?'}mo</> : 'Enter a cost'}
        </span>
        <button onClick={onConfirm} disabled={!canConfirm}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-medium text-white flex items-center gap-1">
          {draft.saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
          Add to register
        </button>
      </div>
    </div>
  );
}

// ── Main modal ───────────────────────────────────────────────────────────────
export function ImportFromInvoice({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'review' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [drafts, setDrafts] = useState<AssetDraft[]>([]);
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [docNote, setDocNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: locData } = useQuery<LocationOption[]>(open ? '/api/locations' : null);
  const locations = useMemo(() => locData ?? [], [locData]);
  const defaultLocationId = locations.length === 1 ? locations[0].id : '';

  useEffect(() => {
    if (!open) {
      setPhase('idle'); setError(null); setFileName(null); setDrafts([]); setDecisionId(null); setDocNote(null);
    }
  }, [open]);

  if (!open) return null;

  const handleFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) { setError('File too large. Maximum 10MB.'); setPhase('error'); return; }
    setFileName(file.name);
    setPhase('parsing');

    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/fixed-assets/parse-invoice', { method: 'POST', body: form });
    let body: ParseResponse & { error?: string };
    try { body = await res.json(); } catch { setError('The server returned an unreadable response.'); setPhase('error'); return; }

    if (!res.ok) { setError(body.error || 'Failed to parse the invoice.'); setPhase('error'); return; }

    setDecisionId(body.meta?.decisionId ?? null);
    setDocNote(body.meta?.documentNote ?? null);
    const assets = body.assets ?? [];
    if (assets.length === 0) {
      setDrafts([]); setPhase('review'); // review phase shows the empty + note state
      return;
    }
    setDrafts(assets.map((a, i) => toDraft(a, i, defaultLocationId)));
    setPhase('review');
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const patchDraft = (key: string, patch: Partial<AssetDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const confirmDraft = async (draft: AssetDraft) => {
    patchDraft(draft.key, { saving: true });
    const costCents = dollarsToCents(Number(String(draft.costInput).replace(/[$,\s]/g, '')) || 0);
    const salvageCents = dollarsToCents(Number(String(draft.salvageInput).replace(/[$,\s]/g, '')) || 0);
    const res = await api.post<{ ok: boolean; assetId: string }>('/api/fixed-assets/parse-invoice/confirm', {
      locationId: draft.locationId,
      assetAccountId: draft.assetAccountId,
      depreciationExpenseAccountId: draft.depExpenseAccountId,
      accumulatedDepreciationAccountId: draft.accumDepAccountId,
      name: draft.name.trim(),
      category: draft.category,
      costCents,
      salvageValueCents: salvageCents,
      usefulLifeMonths: Number(draft.usefulLifeMonths),
      depreciationMethod: draft.method,
      acquisitionDate: draft.acquisitionDate,
      rail: draft.rail,
      decisionId,
    });
    if (res.error) { patchDraft(draft.key, { saving: false }); addToast('error', res.error.error); return; }
    patchDraft(draft.key, { saving: false, done: true });
    addToast('success', `${draft.name} added to the register`);
    onCreated();
  };

  const dismissDraft = (key: string) => setDrafts((prev) => prev.filter((d) => d.key !== key));

  const remaining = drafts.filter((d) => !d.done).length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="w-full max-w-3xl bg-surface-900 border border-slate-800 rounded-2xl shadow-2xl my-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2"><UploadCloud size={16} className="text-emerald-400" /> Add asset from invoice</h2>
            <p className="text-2xs text-slate-500 mt-0.5">Drop a capex invoice — AI proposes the class, useful life, and method for you to confirm.</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Idle: dropzone */}
          {phase === 'idle' && (
            <>
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={clsx('cursor-pointer rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors',
                  dragOver ? 'border-emerald-500 bg-emerald-500/5' : 'border-slate-700 hover:border-slate-600 bg-slate-800/20')}>
                <UploadCloud size={28} className="mx-auto text-slate-500 mb-3" />
                <p className="text-sm text-slate-300">Drop a capex invoice here, or <span className="text-emerald-400">browse</span></p>
                <p className="text-2xs text-slate-500 mt-1">PDF, PNG, JPEG, or WebP · up to 10MB</p>
              </div>
              <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }} />
              <div className="flex items-start gap-2 text-2xs text-slate-500">
                <Info size={12} className="mt-0.5 shrink-0" />
                <span>The AI proposes — it never posts. Nothing is written until you confirm each asset. Prefer to type it in? Use the manual registry entry.</span>
              </div>
            </>
          )}

          {/* Parsing */}
          {phase === 'parsing' && (
            <div className="py-16 text-center">
              <Loader2 size={28} className="mx-auto text-emerald-400 animate-spin mb-3" />
              <p className="text-sm text-slate-300">Reading {fileName ?? 'invoice'}…</p>
              <p className="text-2xs text-slate-500 mt-1">Extracting assets and proposing a class + useful life.</p>
            </div>
          )}

          {/* Error */}
          {phase === 'error' && (
            <div className="py-12 text-center">
              <AlertTriangle size={24} className="mx-auto text-red-400 mb-2" />
              <p className="text-sm text-red-400">{error}</p>
              <button onClick={() => { setPhase('idle'); setError(null); }} className="mt-3 px-3 py-1.5 border border-slate-700 rounded-lg text-xs text-slate-300 hover:bg-slate-800">Try another file</button>
            </div>
          )}

          {/* Review */}
          {phase === 'review' && (
            <>
              {fileName && (
                <div className="flex items-center gap-2 text-2xs text-slate-500">
                  <FileText size={12} /> <span className="text-slate-400">{fileName}</span>
                  {remaining > 0 && <span>· {remaining} proposed asset{remaining === 1 ? '' : 's'} to review</span>}
                </div>
              )}
              {docNote && (
                <div className="flex items-start gap-2 rounded-lg bg-slate-800/40 px-3 py-2 text-2xs text-slate-400">
                  <Info size={12} className="mt-0.5 shrink-0 text-slate-500" /> {docNote}
                </div>
              )}
              {drafts.length === 0 ? (
                <div className="py-10 text-center">
                  <FileText size={22} className="mx-auto text-slate-600 mb-2" />
                  <p className="text-sm text-slate-400">No capitalizable assets found on this invoice.</p>
                  <p className="text-2xs text-slate-500 mt-1">Service charges, supplies, and repairs are expensed, not capitalized.</p>
                  <button onClick={() => { setPhase('idle'); setDrafts([]); }} className="mt-3 px-3 py-1.5 border border-slate-700 rounded-lg text-xs text-slate-300 hover:bg-slate-800">Try another file</button>
                </div>
              ) : (
                <div className="space-y-3">
                  {drafts.map((d) => (
                    <AssetCard key={d.key} draft={d} locations={locations}
                      onPatch={(p) => patchDraft(d.key, p)}
                      onConfirm={() => void confirmDraft(d)}
                      onDismiss={() => dismissDraft(d.key)} />
                  ))}
                  <div className="flex items-center justify-between pt-1">
                    <button onClick={() => { setPhase('idle'); setDrafts([]); }} className="text-2xs text-slate-500 hover:text-slate-300">Upload a different invoice</button>
                    <button onClick={onClose} className="px-3 py-1.5 border border-slate-700 rounded-lg text-xs text-slate-300 hover:bg-slate-800">Done</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
