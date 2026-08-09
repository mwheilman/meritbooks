'use client';

/**
 * P3 create-bill — the propose→confirm surface for the NL bar.
 *
 * 1. POST /api/nl/draft-bill → structured DRAFT (vendor/amount/dates/GL). The
 *    gateway writes an ai_decisions PROPOSED row. NOTHING is created yet.
 * 2. The human reviews / edits the draft (company, vendor, dates, amount, GL,
 *    description).
 * 3. Confirm → POST /api/bills/create — the EXISTING gated bill route, which keeps
 *    its own Zod validation, vendor-compliance holds, and committed-cost
 *    attribution. The copilot adds no parallel path and posts no GL.
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertTriangle, HelpCircle, Check, FileText } from 'lucide-react';
import { addToast } from '@/hooks/use-toast';
import { AiUnavailableNotice } from '@/components/ai/ai-unavailable-notice';

interface Draft {
  vendorName: string;
  vendorId: string | null;
  amountCents: number;
  billDate: string | null;
  dueDate: string | null;
  lineDescription: string;
  accountId: string | null;
  accountLabel: string | null;
  locationId: string | null;
  memo: string | null;
}
interface LocationOption { id: string; name: string; short_code: string }
interface VendorOption { id: string; name: string; display_name?: string | null }
interface AccountOption { id: string; accountNumber: string; name: string; accountType: string; isActive: boolean; approvalStatus: string }

const toCents = (s: string) => Math.round((Number(String(s).replace(/[$,\s]/g, '')) || 0) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);
const plusDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const EXPENSE_TYPES = new Set(['COGS', 'OPEX', 'OTHER']);

export function BillDraftPanel({ description, onDone }: { description: string; onDone: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [clarify, setClarify] = useState<string | null>(null);

  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);

  const [locationId, setLocationId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [billDate, setBillDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [lineDesc, setLineDesc] = useState('');
  const [billNumber, setBillNumber] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Draft + reference data.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [draftRes, locRes, venRes] = await Promise.all([
          fetch('/api/nl/draft-bill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: description }) }),
          fetch('/api/locations'),
          fetch('/api/vendors?per_page=500'),
        ]);
        const draftData = await draftRes.json().catch(() => null);
        if (!alive) return;
        // AI paused (org disabled / budget / no key) → calm notice, not a red error.
        if (draftData?.unavailable) { setUnavailable(draftData.message ?? null); return; }
        if (!draftRes.ok) {
          setError(draftRes.status === 402 ? 'AI budget cap reached — enter this bill manually.' : (draftData?.error ?? 'Could not draft the bill.'));
          return;
        }
        const loc = await locRes.json().catch(() => []);
        setLocations(Array.isArray(loc) ? (loc as LocationOption[]) : []);
        const ven = await venRes.json().catch(() => ({ vendors: [] }));
        setVendors((ven.vendors ?? []) as VendorOption[]);

        if (draftData.clarifyingQuestion && !draftData.draft) { setClarify(draftData.clarifyingQuestion); return; }
        const d = draftData.draft as Draft;
        const today = new Date().toISOString().slice(0, 10);
        const bDate = d.billDate ?? today;
        setBillDate(bDate);
        setDueDate(d.dueDate ?? plusDays(bDate, 30));
        setAmount(fromCents(d.amountCents));
        setVendorId(d.vendorId ?? '');
        setLocationId(d.locationId ?? '');
        setAccountId(d.accountId ?? '');
        setLineDesc(d.lineDescription ?? '');
      } catch {
        if (alive) setError('Could not reach the bill drafter.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [description]);

  // Load the company's accounts once a company is chosen.
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
  const expenseAccounts = usableAccounts.filter((a) => EXPENSE_TYPES.has(a.accountType));

  const submit = useCallback(async () => {
    setSubmitError('');
    if (!locationId) return setSubmitError('Choose a company.');
    if (!vendorId) return setSubmitError('Choose a vendor.');
    if (!accountId) return setSubmitError('Choose a GL account.');
    if (toCents(amount) <= 0) return setSubmitError('Enter an amount.');
    if (!billDate || !dueDate) return setSubmitError('Set the bill and due dates.');
    setSubmitting(true);
    try {
      const cents = toCents(amount);
      const res = await fetch('/api/bills/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          vendor_id: vendorId,
          bill_number: billNumber || undefined,
          bill_date: billDate,
          due_date: dueDate,
          tax_cents: 0,
          retainage_pct: 0,
          lines: [{ description: lineDesc || undefined, account_id: accountId, quantity: 1, unit_cost_cents: cents, amount_cents: cents }],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setSubmitError(data?.error ?? 'Failed to create the bill.'); return; }
      addToast('success', data?.compliance_warning ? 'Bill created (on hold: vendor compliance).' : 'Bill created (pending approval).');
      onDone();
    } catch {
      setSubmitError('Could not create the bill.');
    } finally {
      setSubmitting(false);
    }
  }, [locationId, vendorId, accountId, amount, billDate, dueDate, billNumber, lineDesc, onDone]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-2xs uppercase tracking-wider text-emerald-400">
        <FileText size={13} /> Processing · draft a vendor bill
        <span className="ml-auto text-slate-500 normal-case tracking-normal">advisory — you review &amp; confirm</span>
      </div>
      <p className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-300">&ldquo;{description}&rdquo;</p>

      {loading && <div className="flex items-center gap-2 py-4 text-sm text-slate-400"><Loader2 size={15} className="animate-spin" /> Drafting the bill…</div>}

      {!loading && unavailable !== null && (
        <AiUnavailableNotice message={unavailable} hint="Enter this bill manually from the Bills page in the meantime." />
      )}

      {!loading && !unavailable && error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}</div>
      )}

      {!loading && clarify && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-200">
          <HelpCircle size={16} className="mt-0.5 shrink-0" />
          <div><p className="font-medium">One quick question</p><p className="mt-0.5 text-amber-100/90">{clarify}</p></div>
        </div>
      )}

      {!loading && !unavailable && !error && !clarify && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Company">
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={inputCls}>
                <option value="">Select a company…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.short_code})</option>)}
              </select>
            </Field>
            <Field label="Vendor">
              <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={inputCls}>
                <option value="">Select a vendor…</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.display_name ?? v.name}</option>)}
              </select>
            </Field>
            <Field label="Bill date"><input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} className={inputCls} /></Field>
            <Field label="Due date"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} /></Field>
            <Field label="Amount"><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={`${inputCls} font-mono text-right`} /></Field>
            <Field label="Bill # (optional)"><input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} placeholder="auto" className={inputCls} /></Field>
          </div>
          <Field label="GL account">
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!locationId} className={inputCls}>
              <option value="">{locationId ? 'Select an account…' : 'Choose a company first'}</option>
              {(expenseAccounts.length ? expenseAccounts : usableAccounts).map((a) => (
                <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Description"><input value={lineDesc} onChange={(e) => setLineDesc(e.target.value)} className={inputCls} /></Field>

          <div className="flex flex-wrap items-center gap-3">
            <button onClick={submit} disabled={submitting} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors">
              {submitting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Create bill
            </button>
            <span className="text-2xs text-slate-500">Draft only — creates a PENDING bill, posts no GL</span>
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
