'use client';

/**
 * P4 create-invoice — the propose→confirm surface for the NL bar.
 *
 * 1. POST /api/nl/draft-invoice → structured DRAFT (customer/amount/dates/revenue).
 *    The gateway writes an ai_decisions PROPOSED row. NOTHING is created yet.
 * 2. The human reviews / edits the draft.
 * 3. Confirm → POST /api/invoices (post_to_gl:false) — the EXISTING create route
 *    that delegates to the shared, rev-rec-aware invoice-create core. It lands as a
 *    DRAFT invoice; the copilot forks neither numbering nor rev-rec and posts no GL.
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertTriangle, HelpCircle, Check, FileCheck } from 'lucide-react';
import { addToast } from '@/hooks/use-toast';

interface Draft {
  customerName: string;
  customerId: string | null;
  amountCents: number;
  invoiceDate: string | null;
  dueDate: string | null;
  lineDescription: string;
  accountId: string | null;
  accountLabel: string | null;
  locationId: string | null;
  memo: string | null;
}
interface LocationOption { id: string; name: string; short_code: string }
interface CustomerOption { id: string; name: string; display_name?: string | null }
interface AccountOption { id: string; accountNumber: string; name: string; accountType: string; isActive: boolean; approvalStatus: string }

const toCents = (s: string) => Math.round((Number(String(s).replace(/[$,\s]/g, '')) || 0) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);
const plusDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

export function InvoiceDraftPanel({ description, onDone }: { description: string; onDone: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [clarify, setClarify] = useState<string | null>(null);

  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);

  const [locationId, setLocationId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [lineDesc, setLineDesc] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [draftRes, locRes, custRes] = await Promise.all([
          fetch('/api/nl/draft-invoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: description }) }),
          fetch('/api/locations'),
          fetch('/api/customers?perPage=500'),
        ]);
        const draftData = await draftRes.json().catch(() => null);
        if (!alive) return;
        if (!draftRes.ok) {
          setError(draftRes.status === 402 ? 'AI budget cap reached — enter this invoice manually.' : (draftData?.error ?? 'Could not draft the invoice.'));
          return;
        }
        const loc = await locRes.json().catch(() => []);
        setLocations(Array.isArray(loc) ? (loc as LocationOption[]) : []);
        const cust = await custRes.json().catch(() => ({ customers: [] }));
        setCustomers((cust.customers ?? []) as CustomerOption[]);

        if (draftData.clarifyingQuestion && !draftData.draft) { setClarify(draftData.clarifyingQuestion); return; }
        const d = draftData.draft as Draft;
        const today = new Date().toISOString().slice(0, 10);
        const iDate = d.invoiceDate ?? today;
        setInvoiceDate(iDate);
        setDueDate(d.dueDate ?? plusDays(iDate, 30));
        setAmount(fromCents(d.amountCents));
        setCustomerId(d.customerId ?? '');
        setLocationId(d.locationId ?? '');
        setAccountId(d.accountId ?? '');
        setLineDesc(d.lineDescription ?? '');
      } catch {
        if (alive) setError('Could not reach the invoice drafter.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [description]);

  useEffect(() => {
    if (!locationId) { setAccounts([]); return; }
    let alive = true;
    fetch(`/api/accounts?location_id=${locationId}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d) => { if (alive) setAccounts((d.data ?? []) as AccountOption[]); })
      .catch(() => alive && setAccounts([]));
    return () => { alive = false; };
  }, [locationId]);

  const usableAccounts = accounts.filter((a) => a.isActive && a.approvalStatus === 'APPROVED');
  const revenueAccounts = usableAccounts.filter((a) => a.accountType === 'REVENUE' || a.accountType === 'OTHER');

  const submit = useCallback(async () => {
    setSubmitError('');
    if (!locationId) return setSubmitError('Choose a company.');
    if (!customerId) return setSubmitError('Choose a customer.');
    if (!accountId) return setSubmitError('Choose a revenue account.');
    if (toCents(amount) <= 0) return setSubmitError('Enter an amount.');
    if (!invoiceDate || !dueDate) return setSubmitError('Set the invoice and due dates.');
    setSubmitting(true);
    try {
      const cents = toCents(amount);
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          customer_id: customerId,
          invoice_date: invoiceDate,
          due_date: dueDate,
          tax_cents: 0,
          retainage_pct: 0,
          is_progress_bill: false,
          post_to_gl: false, // draft only — never posts from the copilot
          lines: [{ description: lineDesc || 'Services', account_id: accountId, quantity: 1, unit_price_cents: cents }],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setSubmitError(data?.error ?? 'Failed to create the invoice.'); return; }
      addToast('success', `Draft invoice ${data?.invoice_number ?? ''} created.`);
      onDone();
    } catch {
      setSubmitError('Could not create the invoice.');
    } finally {
      setSubmitting(false);
    }
  }, [locationId, customerId, accountId, amount, invoiceDate, dueDate, lineDesc, onDone]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-2xs uppercase tracking-wider text-emerald-400">
        <FileCheck size={13} /> Processing · draft a customer invoice
        <span className="ml-auto text-slate-500 normal-case tracking-normal">advisory — you review &amp; confirm</span>
      </div>
      <p className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-300">&ldquo;{description}&rdquo;</p>

      {loading && <div className="flex items-center gap-2 py-4 text-sm text-slate-400"><Loader2 size={15} className="animate-spin" /> Drafting the invoice…</div>}

      {!loading && error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}</div>
      )}

      {!loading && clarify && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-200">
          <HelpCircle size={16} className="mt-0.5 shrink-0" />
          <div><p className="font-medium">One quick question</p><p className="mt-0.5 text-amber-100/90">{clarify}</p></div>
        </div>
      )}

      {!loading && !error && !clarify && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Company">
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={inputCls}>
                <option value="">Select a company…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.short_code})</option>)}
              </select>
            </Field>
            <Field label="Customer">
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={inputCls}>
                <option value="">Select a customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.display_name ?? c.name}</option>)}
              </select>
            </Field>
            <Field label="Invoice date"><input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className={inputCls} /></Field>
            <Field label="Due date"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount"><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={`${inputCls} font-mono text-right`} /></Field>
            <Field label="Revenue account">
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!locationId} className={inputCls}>
                <option value="">{locationId ? 'Select an account…' : 'Choose a company first'}</option>
                {(revenueAccounts.length ? revenueAccounts : usableAccounts).map((a) => (
                  <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Description"><input value={lineDesc} onChange={(e) => setLineDesc(e.target.value)} className={inputCls} /></Field>

          <div className="flex flex-wrap items-center gap-3">
            <button onClick={submit} disabled={submitting} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors">
              {submitting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Create draft invoice
            </button>
            <span className="text-2xs text-slate-500">Draft only — rev-rec aware, posts no GL</span>
            {submitError && <span className="text-xs text-rose-400">{submitError}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white';
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1">{label}</label>
      {children}
    </div>
  );
}
