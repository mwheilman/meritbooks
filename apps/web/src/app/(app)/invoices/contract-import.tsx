'use client';

/**
 * Import from contract / SOW — DROP-AND-PARSE invoice + rev-rec setup.
 *
 * Drop a signed customer contract or SOW; the AI (via the metered Core AI gateway)
 * extracts the billing terms and this panel walks the user through a review →
 * confirm flow. Nothing is written until confirm. On confirm it creates the
 * invoice(s) through the EXISTING gated create paths — `POST /api/invoices`
 * (one per one-time bill or per milestone; post_to_gl defaults false → DRAFT) or
 * `POST /api/recurring-invoices` (the existing recurring template path) — and, when
 * the customer is new, `POST /api/customers`. Manual invoice creation stays the
 * fallback; this is an additive lane.
 */

import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks/use-query';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  UploadCloud, FileText, Loader2, X, Trash2, Sparkles, AlertTriangle, Info, Plus, Check,
} from 'lucide-react';

// ─── Types (mirror /api/invoices/parse-contract) ──────────────────────────────

type BillingKind = 'ONE_TIME' | 'MILESTONE' | 'RECURRING';
type RecurringFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
type RevRecMethod =
  | 'POINT_OF_SALE' | 'AS_BILLED' | 'PCT_COSTS_INCURRED' | 'PCT_COMPLETE'
  | 'COMPLETED_CONTRACT' | 'MILESTONE' | 'RATABLY' | 'SUBSCRIPTION' | 'CASH';

interface LineItem { description: string; quantity: number; unit_price_cents: number; amount_cents: number }
interface Milestone { name: string; description: string | null; due_date: string | null; amount_cents: number }
interface Recurring {
  cadence: RecurringFrequency; interval_count: number; amount_cents: number;
  start_date: string | null; end_date: string | null; occurrences: number | null;
}
interface RevRec {
  method: RevRecMethod; timing: string; pattern: string; recognizesAtBilling: boolean;
  reasoning: string | null; confidence: number;
}
interface Contract {
  customer: { name: string | null; email: string | null; matchKey: string };
  contract_title: string | null;
  total_contract_value_cents: number | null;
  start_date: string | null;
  end_date: string | null;
  currency: string | null;
  billing_kind: BillingKind;
  line_items: LineItem[];
  milestones: Milestone[];
  recurring: Recurring | null;
  rev_rec: RevRec;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
  notes: string | null;
}
interface CustomerCandidate { id: string; name: string; email: string | null; payment_terms_days: number | null }
type CustomerMatch =
  | { type: 'MATCHED'; customer: CustomerCandidate }
  | { type: 'PROPOSED'; name: string | null; email: string | null; candidates: CustomerCandidate[] };
interface ParseResponse {
  contract: Contract;
  customerMatch: CustomerMatch;
  meta: { fileName: string; model: string; documentNote: string | null; extractionMs: number };
}

interface LocationOption { id: string; name: string; short_code: string }
interface AccountOption { id: string; account_number: string; name: string; account_type: string }

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const REV_REC_OPTIONS: { value: RevRecMethod; label: string }[] = [
  { value: 'POINT_OF_SALE', label: 'Point of sale (recognize at billing)' },
  { value: 'AS_BILLED', label: 'Billing-based / as billed (recognize at billing)' },
  { value: 'PCT_COSTS_INCURRED', label: 'Percent of costs incurred (cost-to-cost)' },
  { value: 'PCT_COMPLETE', label: 'Percent complete (physical)' },
  { value: 'COMPLETED_CONTRACT', label: 'Completed contract (defer to completion)' },
  { value: 'MILESTONE', label: 'Milestone / point-in-time' },
  { value: 'RATABLY', label: 'Straight-line / ratable' },
  { value: 'SUBSCRIPTION', label: 'Subscription (ratable)' },
  { value: 'CASH', label: 'Cash basis' },
];

const CADENCE_OPTIONS: RecurringFrequency[] = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'];

const NEW_CUSTOMER = '__NEW__';

const inputCls =
  'w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-xs text-white focus:border-emerald-500 focus:outline-none';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function ContractImport({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [phase, setPhase] = useState<'upload' | 'parsing' | 'review' | 'confirming'>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ParseResponse['meta'] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Editable review state (populated from the parse response).
  const [contract, setContract] = useState<Contract | null>(null);
  const [lowFields, setLowFields] = useState<string[]>([]);
  const [locationId, setLocationId] = useState('');
  const [customerId, setCustomerId] = useState(''); // existing id, or NEW_CUSTOMER
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerEmail, setNewCustomerEmail] = useState('');
  const [revenueAccountId, setRevenueAccountId] = useState('');
  const [revRecMethod, setRevRecMethod] = useState<RevRecMethod>('AS_BILLED');
  const [lines, setLines] = useState<LineItem[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [recurring, setRecurring] = useState<Recurring | null>(null);
  const [billingKind, setBillingKind] = useState<BillingKind>('ONE_TIME');

  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];
  const { data: custData } = useQuery<{ customers: CustomerCandidate[] }>('/api/customers?per_page=500');
  const customers = custData?.customers ?? [];
  const { data: acctData } = useQuery<{ recent: AccountOption[]; accounts: AccountOption[] }>('/api/accounts/search');
  const revenueAccounts = [...(acctData?.recent ?? []), ...(acctData?.accounts ?? [])]
    .filter((a) => a.account_type === 'REVENUE')
    .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i);

  const parse = useCallback(async (file: File) => {
    setError(null);
    if (!ALLOWED.includes(file.type)) { setError('Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('File too large. Maximum 10MB.'); return; }
    setPhase('parsing');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/invoices/parse-contract', { method: 'POST', body: formData });
      const body = (await res.json()) as ParseResponse | { error: string };
      if (!res.ok || 'error' in body) {
        setError('error' in body ? body.error : 'Failed to parse contract');
        setPhase('upload');
        return;
      }
      const c = body.contract;
      setMeta(body.meta);
      setContract(c);
      setLowFields(c.lowConfidenceFields ?? []);
      setBillingKind(c.billing_kind);
      setLines(c.line_items.length > 0 ? c.line_items : [{ description: c.contract_title ?? 'Contract charge', quantity: 1, unit_price_cents: c.total_contract_value_cents ?? 0, amount_cents: c.total_contract_value_cents ?? 0 }]);
      setMilestones(c.milestones);
      setRecurring(
        c.recurring ??
          (c.billing_kind === 'RECURRING'
            ? { cadence: 'MONTHLY', interval_count: 1, amount_cents: 0, start_date: c.start_date, end_date: c.end_date, occurrences: null }
            : null),
      );
      setRevRecMethod(c.rev_rec.method);
      // Customer default: matched → its id; else create-new prefilled with the parsed name.
      if (body.customerMatch.type === 'MATCHED') {
        setCustomerId(body.customerMatch.customer.id);
      } else {
        setCustomerId(NEW_CUSTOMER);
        setNewCustomerName(body.customerMatch.name ?? '');
        setNewCustomerEmail(body.customerMatch.email ?? '');
      }
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setPhase('upload');
    }
  }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void parse(file);
  }

  const flag = (field: string) => (lowFields.includes(field) ? 'border-amber-500/60 ring-1 ring-amber-500/30' : '');

  // Derived totals for the review summary.
  const oneTimeTotal = lines.reduce((s, l) => s + Math.round(l.quantity * l.unit_price_cents), 0);
  const milestoneTotal = milestones.reduce((s, m) => s + m.amount_cents, 0);

  // ── Line editing ─────────────────────────────────────────────────────────────
  const setLine = (i: number, patch: Partial<LineItem>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { description: '', quantity: 1, unit_price_cents: 0, amount_cents: 0 }]);
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls));

  const setMs = (i: number, patch: Partial<Milestone>) =>
    setMilestones((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const addMs = () => setMilestones((ms) => [...ms, { name: '', description: null, due_date: null, amount_cents: 0 }]);
  const removeMs = (i: number) => setMilestones((ms) => ms.filter((_, j) => j !== i));

  // ── Confirm ──────────────────────────────────────────────────────────────────
  async function confirm() {
    if (!contract) return;
    setError(null);

    if (!locationId) { addToast('error', 'Pick a company for the invoice.'); return; }
    if (!revenueAccountId) { addToast('error', 'Pick a revenue GL account.'); return; }
    if (customerId === NEW_CUSTOMER && !newCustomerName.trim()) { addToast('error', 'Enter a name for the new customer.'); return; }
    if (!customerId) { addToast('error', 'Pick or create a customer.'); return; }

    const methodLabel = REV_REC_OPTIONS.find((m) => m.value === revRecMethod)?.label ?? revRecMethod;
    const revRecNote = `Rev-rec: ${methodLabel}`;

    setPhase('confirming');
    try {
      // 1. Resolve the customer (create if new).
      let custId = customerId;
      let termsDays = 30;
      if (customerId === NEW_CUSTOMER) {
        const created = await api.post<{ customer: { id: string } }>('/api/customers', {
          name: newCustomerName.trim(),
          email: newCustomerEmail.trim() || undefined,
          location_id: locationId,
        });
        if (created.error || !created.data) {
          setError(created.error?.error ?? 'Failed to create customer');
          setPhase('review');
          return;
        }
        custId = created.data.customer.id;
      } else {
        termsDays = customers.find((c) => c.id === customerId)?.payment_terms_days ?? 30;
      }

      const baseMemo = contract.contract_title ? `${contract.contract_title} — ${revRecNote}` : revRecNote;

      if (billingKind === 'RECURRING') {
        if (!recurring || recurring.amount_cents <= 0) { setError('Recurring amount must be greater than zero.'); setPhase('review'); return; }
        const start = recurring.start_date ?? contract.start_date ?? todayISO();
        const r = await api.post<{ id: string }>('/api/recurring-invoices', {
          name: contract.contract_title ?? `${newCustomerNameOr(custId)} recurring`,
          location_id: locationId,
          customer_id: custId,
          frequency: recurring.cadence,
          interval_count: recurring.interval_count,
          start_date: start,
          end_date: recurring.end_date ?? undefined,
          occurrences: recurring.occurrences ?? undefined,
          auto_send: false,
          memo: baseMemo,
          tax_cents: 0,
          terms: termsDays,
          lines: [{ description: contract.contract_title ?? 'Recurring charge', account_id: revenueAccountId, quantity: 1, unit_price_cents: recurring.amount_cents }],
        });
        if (r.error) { setError(r.error.error); setPhase('review'); return; }
        addToast('success', 'Recurring billing schedule created from the contract.');
        onCreated();
        return;
      }

      if (billingKind === 'MILESTONE') {
        if (milestones.length === 0) { setError('Add at least one milestone.'); setPhase('review'); return; }
        let ok = 0;
        let failed = 0;
        for (const m of milestones) {
          const invDate = m.due_date ?? todayISO();
          const res = await api.post('/api/invoices', {
            location_id: locationId,
            customer_id: custId,
            invoice_date: invDate,
            due_date: addDays(invDate, termsDays),
            memo: `${m.name}${m.description ? ` — ${m.description}` : ''} · ${baseMemo}`,
            tax_cents: 0,
            lines: [{ description: m.name || 'Milestone', account_id: revenueAccountId, quantity: 1, unit_price_cents: m.amount_cents }],
          });
          if (res.error) failed += 1; else ok += 1;
        }
        if (failed > 0) { addToast('error', `${ok} invoice(s) created · ${failed} failed`); }
        else addToast('success', `${ok} milestone invoice${ok === 1 ? '' : 's'} created (draft).`);
        onCreated();
        return;
      }

      // ONE_TIME
      const invDate = contract.start_date ?? todayISO();
      const res = await api.post<{ invoice_id: string }>('/api/invoices', {
        location_id: locationId,
        customer_id: custId,
        invoice_date: invDate,
        due_date: addDays(invDate, termsDays),
        memo: baseMemo,
        tax_cents: 0,
        lines: lines.map((l) => ({
          description: l.description || 'Contract charge',
          account_id: revenueAccountId,
          quantity: l.quantity,
          unit_price_cents: l.unit_price_cents,
        })),
      });
      if (res.error) { setError(res.error.error); setPhase('review'); return; }
      addToast('success', 'Invoice created from the contract (draft).');
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setPhase('review');
    }
  }

  function newCustomerNameOr(id: string): string {
    if (id === NEW_CUSTOMER || customerId === NEW_CUSTOMER) return newCustomerName || 'Customer';
    return customers.find((c) => c.id === id)?.name ?? 'Customer';
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-4xl max-h-[92vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-indigo-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">Import from contract or SOW</h2>
              <p className="text-[11px] text-slate-500">
                Drop a signed customer contract — AI proposes the invoice(s) and rev-rec method; you review and confirm. Nothing is saved until you confirm.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Upload / parsing */}
        {(phase === 'upload' || phase === 'parsing') && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => phase === 'upload' && fileInput.current?.click()}
            className={clsx(
              'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors',
              phase === 'parsing'
                ? 'border-indigo-500/40 bg-indigo-500/5 cursor-default'
                : dragOver
                  ? 'border-emerald-500 bg-emerald-500/5 cursor-pointer'
                  : 'border-slate-700 hover:border-slate-600 cursor-pointer',
            )}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void parse(f); e.target.value = ''; }}
            />
            {phase === 'parsing' ? (
              <>
                <Loader2 className="w-9 h-9 text-indigo-400 animate-spin mb-3" />
                <p className="text-sm text-slate-300">Reading the contract and extracting billing terms…</p>
                <p className="text-[11px] text-slate-500 mt-1">This can take 15-30 seconds for a long agreement.</p>
              </>
            ) : (
              <>
                <UploadCloud className="w-10 h-10 text-slate-500 mb-3" />
                <p className="text-sm text-slate-200 font-medium">Drop a signed contract or SOW here</p>
                <p className="text-[11px] text-slate-500 mt-1">or click to browse · PDF, PNG, JPEG · up to 10MB</p>
              </>
            )}
          </div>
        )}

        {/* Review */}
        {(phase === 'review' || phase === 'confirming') && contract && (
          <div className="space-y-4">
            {/* File + doc note */}
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <FileText size={13} className="text-indigo-400" />
              <span className="truncate max-w-[240px]">{meta?.fileName}</span>
              <span className="text-slate-600">·</span>
              <span className="uppercase tracking-wide">{billingKind.replace('_', ' ')}</span>
            </div>
            {meta?.documentNote && (
              <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400">
                <Info size={13} className="mt-0.5 shrink-0 text-slate-500" /> {meta.documentNote}
              </div>
            )}

            {/* Customer + company */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-slate-500 mb-1">Customer</label>
                <select className={clsx(inputCls, flag('customer'))} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value={NEW_CUSTOMER}>+ Create new{contract.customer.name ? ` — "${contract.customer.name}"` : ''}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {customerId === NEW_CUSTOMER && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <input className={inputCls} placeholder="Customer name" value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} />
                    <input className={inputCls} placeholder="Billing email (optional)" value={newCustomerEmail} onChange={(e) => setNewCustomerEmail(e.target.value)} />
                  </div>
                )}
              </div>
              <div>
                <label className="block text-[10px] text-slate-500 mb-1">Company *</label>
                <select className={inputCls} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Select company</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Revenue account + rev-rec method */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-slate-500 mb-1">Revenue GL account *</label>
                <select className={inputCls} value={revenueAccountId} onChange={(e) => setRevenueAccountId(e.target.value)}>
                  <option value="">Select revenue account</option>
                  {revenueAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] text-slate-500 mb-1 flex items-center gap-1">
                  Rev-rec method
                  <span className="text-indigo-400/80">· AI suggested {REV_REC_OPTIONS.find((m) => m.value === contract.rev_rec.method)?.label.split(' (')[0]}</span>
                </label>
                <select className={clsx(inputCls, flag('rev_rec'))} value={revRecMethod} onChange={(e) => setRevRecMethod(e.target.value as RevRecMethod)}>
                  {REV_REC_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
            </div>
            {contract.rev_rec.reasoning && (
              <p className="text-[11px] text-slate-400 italic bg-slate-900/60 rounded-md px-2 py-1.5 border-l-2 border-indigo-500/40">
                &ldquo;{contract.rev_rec.reasoning}&rdquo;
              </p>
            )}

            {/* Schedule editor */}
            {billingKind === 'ONE_TIME' && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider">Line items</label>
                  <button onClick={addLine} className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1"><Plus size={11} /> Add line</button>
                </div>
                <div className="space-y-2">
                  {lines.map((l, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <input className={clsx(inputCls, 'col-span-6')} placeholder="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                      <input className={clsx(inputCls, 'col-span-2 text-right font-mono')} type="number" min={0} step={0.01} value={l.quantity} onChange={(e) => setLine(i, { quantity: parseFloat(e.target.value) || 0 })} />
                      <input className={clsx(inputCls, 'col-span-3 text-right font-mono')} type="number" min={0} step={0.01} value={(l.unit_price_cents / 100).toFixed(2)} onChange={(e) => setLine(i, { unit_price_cents: Math.round((parseFloat(e.target.value) || 0) * 100) })} />
                      <button onClick={() => removeLine(i)} className="col-span-1 p-1 text-slate-500 hover:text-red-400" aria-label="Remove line"><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex justify-end text-xs text-slate-300">Total <span className="font-mono text-emerald-400 ml-2">{formatMoney(oneTimeTotal)}</span></div>
              </div>
            )}

            {billingKind === 'MILESTONE' && (
              <div className={clsx(flag('milestones') && 'rounded-lg p-2', flag('milestones'))}>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider">Milestones (one invoice each)</label>
                  <button onClick={addMs} className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1"><Plus size={11} /> Add milestone</button>
                </div>
                <div className="space-y-2">
                  {milestones.map((m, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <input className={clsx(inputCls, 'col-span-4')} placeholder="Milestone name" value={m.name} onChange={(e) => setMs(i, { name: e.target.value })} />
                      <input className={clsx(inputCls, 'col-span-4')} type="date" value={m.due_date ?? ''} onChange={(e) => setMs(i, { due_date: e.target.value || null })} />
                      <input className={clsx(inputCls, 'col-span-3 text-right font-mono')} type="number" min={0} step={0.01} value={(m.amount_cents / 100).toFixed(2)} onChange={(e) => setMs(i, { amount_cents: Math.round((parseFloat(e.target.value) || 0) * 100) })} />
                      <button onClick={() => removeMs(i)} className="col-span-1 p-1 text-slate-500 hover:text-red-400" aria-label="Remove milestone"><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex justify-end text-xs text-slate-300">Total <span className="font-mono text-emerald-400 ml-2">{formatMoney(milestoneTotal)}</span></div>
              </div>
            )}

            {billingKind === 'RECURRING' && recurring && (
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-3">
                  <label className="block text-[10px] text-slate-500 mb-1">Cadence</label>
                  <select className={inputCls} value={recurring.cadence} onChange={(e) => setRecurring({ ...recurring, cadence: e.target.value as RecurringFrequency })}>
                    {CADENCE_OPTIONS.map((c) => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] text-slate-500 mb-1">Every</label>
                  <input className={clsx(inputCls, 'text-right font-mono')} type="number" min={1} value={recurring.interval_count} onChange={(e) => setRecurring({ ...recurring, interval_count: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
                </div>
                <div className="col-span-3">
                  <label className="block text-[10px] text-slate-500 mb-1">Amount / period</label>
                  <input className={clsx(inputCls, 'text-right font-mono', flag('recurring_amount'))} type="number" min={0} step={0.01} value={(recurring.amount_cents / 100).toFixed(2)} onChange={(e) => setRecurring({ ...recurring, amount_cents: Math.round((parseFloat(e.target.value) || 0) * 100) })} />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] text-slate-500 mb-1"># periods</label>
                  <input className={clsx(inputCls, 'text-right font-mono')} type="number" min={1} placeholder="∞" value={recurring.occurrences ?? ''} onChange={(e) => setRecurring({ ...recurring, occurrences: e.target.value === '' ? null : Math.max(1, parseInt(e.target.value, 10) || 1) })} />
                </div>
                <div className="col-span-2" />
                <div className="col-span-3">
                  <label className="block text-[10px] text-slate-500 mb-1">Start</label>
                  <input className={clsx(inputCls, flag('start_date'))} type="date" value={recurring.start_date ?? ''} onChange={(e) => setRecurring({ ...recurring, start_date: e.target.value || null })} />
                </div>
                <div className="col-span-3">
                  <label className="block text-[10px] text-slate-500 mb-1">End (optional)</label>
                  <input className={inputCls} type="date" value={recurring.end_date ?? ''} onChange={(e) => setRecurring({ ...recurring, end_date: e.target.value || null })} />
                </div>
              </div>
            )}

            {lowFields.length > 0 && (
              <div className="flex items-center gap-1.5 text-[10px] text-amber-400/80">
                <AlertTriangle size={11} /> Review the highlighted field{lowFields.length === 1 ? '' : 's'} — the AI was unsure or the value was not stated.
              </div>
            )}

            {/* Actions */}
            <div className="mt-2 flex items-center justify-between border-t border-slate-800 pt-4">
              <p className="text-[11px] text-slate-600 max-w-md">
                Confirmed invoices are created as drafts through the standard invoice / recurring-invoice paths — same numbering, rev-rec treatment, and validation as manual entry.
              </p>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
                <button
                  onClick={confirm}
                  disabled={phase === 'confirming'}
                  className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
                >
                  {phase === 'confirming' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {billingKind === 'RECURRING' ? 'Create recurring schedule' : billingKind === 'MILESTONE' ? `Create ${milestones.length} milestone invoice${milestones.length === 1 ? '' : 's'}` : 'Create invoice'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
