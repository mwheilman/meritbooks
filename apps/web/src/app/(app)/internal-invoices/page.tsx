'use client';

import { useState, useMemo } from 'react';
import { Loader2, AlertCircle, Plus, ArrowLeftRight, Trash2, X, Check, Ban, Send } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { PageHeader, EmptyState } from '@/components/ui';

type Status = 'draft' | 'sent' | 'approved' | 'rejected' | 'booked' | 'void';
type ChargeMethod = 'inherit' | 'revenue' | 'cost_transfer';

interface DeptRef { id: string; name: string; code: string }
interface LocRef { id: string; name: string; short_code: string }

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  memo: string | null;
  status: Status;
  chargeMethod: ChargeMethod;
  totalCents: number;
  bookedGlEntryId: string | null;
  rejectionReason: string | null;
  location: LocRef | null;
  provider: DeptRef | null;
  receiver: DeptRef | null;
}

interface ListResponse { data: InvoiceRow[]; counts: Record<string, number> }
interface DepartmentRow { id: string; name: string; code: string; locationId: string | null; isActive: boolean }
interface DepartmentsResponse { departments: DepartmentRow[] }
interface LocationRow { id: string; name: string; short_code: string }

const STATUS_STYLE: Record<Status, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-slate-500/10 text-slate-400' },
  sent: { label: 'Awaiting approval', className: 'bg-amber-500/10 text-amber-400' },
  approved: { label: 'Approved', className: 'bg-emerald-500/10 text-emerald-400' },
  booked: { label: 'Booked', className: 'bg-emerald-500/10 text-emerald-400' },
  rejected: { label: 'Rejected', className: 'bg-red-500/10 text-red-400' },
  void: { label: 'Void', className: 'bg-slate-600/10 text-slate-500' },
};

const fmt = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const today = () => new Date().toISOString().slice(0, 10);

interface LineDraft { description: string; amount: string }

interface FormState {
  locationId: string;
  providerId: string;
  receiverId: string;
  invoiceDate: string;
  memo: string;
  lines: LineDraft[];
}

const EMPTY_FORM: FormState = {
  locationId: '',
  providerId: '',
  receiverId: '',
  invoiceDate: today(),
  memo: '',
  lines: [{ description: '', amount: '' }],
};

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'sent', label: 'Awaiting approval' },
  { key: 'booked', label: 'Booked' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'void', label: 'Void' },
];

export default function InternalInvoicesPage() {
  const [filter, setFilter] = useState('all');
  const { data, isLoading, error, refetch } = useQuery<ListResponse>(
    `/api/internal-invoices${filter !== 'all' ? `?status=${filter}` : ''}`,
  );
  const { data: deptData } = useQuery<DepartmentsResponse>('/api/departments');
  const { data: locations } = useQuery<LocationRow[]>('/api/locations');

  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<InvoiceRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const rows = data?.data ?? [];
  const counts = data?.counts ?? {};
  const locs = locations ?? [];
  const activeDepts = useMemo(
    () => (deptData?.departments ?? []).filter((d) => d.isActive),
    [deptData],
  );

  const companyDepts = (locationId: string) => activeDepts.filter((d) => d.locationId === locationId);

  const total = form ? form.lines.reduce((s, l) => s + Math.round((parseFloat(l.amount) || 0) * 100), 0) : 0;

  async function createInvoice() {
    if (!form) return;
    if (!form.locationId || !form.providerId || !form.receiverId) {
      addToast('error', 'Select a company, provider, and receiver department.'); return;
    }
    if (form.providerId === form.receiverId) {
      addToast('error', 'Provider and receiver must be different departments.'); return;
    }
    const lines = form.lines
      .map((l) => ({ description: l.description.trim(), amount_cents: Math.round((parseFloat(l.amount) || 0) * 100) }))
      .filter((l) => l.description && l.amount_cents > 0);
    if (lines.length === 0) { addToast('error', 'Add at least one line with a description and amount.'); return; }

    setSaving(true);
    try {
      const res = await fetch('/api/internal-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: form.locationId,
          provider_department_id: form.providerId,
          receiver_department_id: form.receiverId,
          invoice_date: form.invoiceDate,
          memo: form.memo || null,
          lines,
        }),
      });
      const json = await res.json();
      if (!res.ok) { addToast('error', json.error ?? 'Could not create invoice.'); return; }
      addToast('success', `Invoice ${json.invoiceNumber} created as a draft.`);
      setForm(null);
      await refetch();
    } catch {
      addToast('error', 'Network error — please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function act(inv: InvoiceRow, action: 'send' | 'approve' | 'reject' | 'void', reason?: string) {
    setBusyId(inv.id);
    try {
      const res = await fetch(`/api/internal-invoices/${inv.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason: reason ?? null }),
      });
      const json = await res.json();
      if (!res.ok) { addToast('error', json.error ?? 'Action failed.'); return; }
      const msg: Record<string, string> = {
        send: 'Sent to the receiving department for approval.',
        approve: 'Approved and booked to the general ledger.',
        reject: 'Invoice rejected.',
        void: 'Invoice voided.',
      };
      addToast('success', msg[action]);
      setRejecting(null); setRejectReason('');
      await refetch();
    } catch {
      addToast('error', 'Network error — please try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Internal Invoices"
        description="Inter-department charges. The providing department invoices the receiver; on approval it books to the GL and nets to zero at the company roll-up."
        actions={
          <button
            onClick={() => setForm({ ...EMPTY_FORM, lines: [{ description: '', amount: '' }] })}
            disabled={locs.length === 0}
            className="btn-primary btn-sm inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> New Invoice
          </button>
        }
      />

      {/* Status filter */}
      <div className="flex flex-wrap gap-2 mt-4 mb-5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-sm transition-colors',
              filter === f.key ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5',
            )}
          >
            {f.label}
            {counts[f.key] != null && <span className="ml-1.5 text-xs opacity-70">{counts[f.key]}</span>}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading invoices…
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-400 bg-red-500/10 rounded-lg p-4">
          <AlertCircle className="w-5 h-5" /> Could not load invoices.
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <EmptyState
          icon={ArrowLeftRight}
          title="No internal invoices yet"
          description={
            locs.length === 0
              ? 'Add a company and its departments first, then one department can invoice another.'
              : 'When one department provides services to another, create an internal invoice here.'
          }
        />
      )}

      {!isLoading && !error && rows.length > 0 && (
        <div className="rounded-xl border border-white/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-4 py-3">Invoice</th>
                <th className="text-left font-medium px-4 py-3">Company</th>
                <th className="text-left font-medium px-4 py-3">Provider → Receiver</th>
                <th className="text-right font-medium px-4 py-3">Amount</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
                <th className="text-right font-medium px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const st = STATUS_STYLE[inv.status];
                const busy = busyId === inv.id;
                return (
                  <tr key={inv.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-200">{inv.invoiceNumber}</div>
                      <div className="text-xs text-slate-500">{inv.invoiceDate}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{inv.location?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-300">
                      <span className="text-slate-200">{inv.provider?.name ?? '?'}</span>
                      <span className="text-slate-500"> → </span>
                      <span className="text-slate-200">{inv.receiver?.name ?? '?'}</span>
                      {inv.status !== 'draft' && (
                        <span className="ml-2 text-xs text-slate-500">
                          ({inv.chargeMethod === 'cost_transfer' ? 'cost transfer' : 'revenue'})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-200">{fmt(inv.totalCents)}</td>
                    <td className="px-4 py-3">
                      <span className={clsx('inline-block px-2 py-0.5 rounded text-xs font-medium', st.className)}>{st.label}</span>
                      {inv.status === 'rejected' && inv.rejectionReason && (
                        <div className="text-xs text-slate-500 mt-1 max-w-[200px] truncate" title={inv.rejectionReason}>{inv.rejectionReason}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        {busy && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                        {!busy && inv.status === 'draft' && (
                          <>
                            <button onClick={() => act(inv, 'send')} className="btn-primary btn-sm inline-flex items-center gap-1">
                              <Send className="w-3.5 h-3.5" /> Send
                            </button>
                            <button onClick={() => act(inv, 'void')} className="btn-ghost btn-sm">Void</button>
                          </>
                        )}
                        {!busy && inv.status === 'sent' && (
                          <>
                            <button onClick={() => act(inv, 'approve')} className="btn-primary btn-sm inline-flex items-center gap-1">
                              <Check className="w-3.5 h-3.5" /> Approve
                            </button>
                            <button onClick={() => { setRejecting(inv); setRejectReason(''); }} className="btn-ghost btn-sm inline-flex items-center gap-1">
                              <Ban className="w-3.5 h-3.5" /> Reject
                            </button>
                          </>
                        )}
                        {!busy && inv.status === 'booked' && inv.bookedGlEntryId && (
                          <a href={`/journal-entries?highlight=${inv.bookedGlEntryId}`} className="btn-ghost btn-sm">View GL</a>
                        )}
                        {!busy && inv.status === 'rejected' && (
                          <button onClick={() => act(inv, 'void')} className="btn-ghost btn-sm">Void</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      {form && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => !saving && setForm(null)}>
          <div className="bg-[#0f1729] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <h2 className="text-lg font-semibold text-slate-100">New internal invoice</h2>
              <button onClick={() => !saving && setForm(null)} className="text-slate-400 hover:text-slate-200"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-sm text-slate-400 mb-1.5">Company *</label>
                <select
                  value={form.locationId}
                  onChange={(e) => setForm({ ...form, locationId: e.target.value, providerId: '', receiverId: '' })}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-slate-200"
                >
                  <option value="">Select a company…</option>
                  {locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-slate-400 mb-1.5">Provider department *</label>
                  <select
                    value={form.providerId}
                    onChange={(e) => setForm({ ...form, providerId: e.target.value })}
                    disabled={!form.locationId}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-slate-200 disabled:opacity-50"
                  >
                    <option value="">Select…</option>
                    {companyDepts(form.locationId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1.5">Receiver department *</label>
                  <select
                    value={form.receiverId}
                    onChange={(e) => setForm({ ...form, receiverId: e.target.value })}
                    disabled={!form.locationId}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-slate-200 disabled:opacity-50"
                  >
                    <option value="">Select…</option>
                    {companyDepts(form.locationId).filter((d) => d.id !== form.providerId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-slate-400 mb-1.5">Invoice date</label>
                  <input type="date" value={form.invoiceDate} onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-slate-200" />
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1.5">Memo</label>
                  <input type="text" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="Optional"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-slate-200" />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm text-slate-400">Line items</label>
                  <button onClick={() => setForm({ ...form, lines: [...form.lines, { description: '', amount: '' }] })}
                    className="btn-ghost btn-sm inline-flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add line</button>
                </div>
                <div className="space-y-2">
                  {form.lines.map((line, i) => (
                    <div key={i} className="flex gap-2">
                      <input type="text" value={line.description} placeholder="Description"
                        onChange={(e) => { const ls = [...form.lines]; ls[i] = { ...ls[i], description: e.target.value }; setForm({ ...form, lines: ls }); }}
                        className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-slate-200" />
                      <input type="number" min="0" step="0.01" value={line.amount} placeholder="0.00"
                        onChange={(e) => { const ls = [...form.lines]; ls[i] = { ...ls[i], amount: e.target.value }; setForm({ ...form, lines: ls }); }}
                        className="w-32 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-slate-200 text-right font-mono" />
                      <button onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}
                        disabled={form.lines.length === 1} className="text-slate-500 hover:text-red-400 disabled:opacity-30 px-1">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end mt-3 text-sm">
                  <span className="text-slate-400 mr-3">Total</span>
                  <span className="font-mono text-slate-100 font-semibold">{fmt(total)}</span>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-white/10">
              <button onClick={() => !saving && setForm(null)} className="btn-ghost btn-sm">Cancel</button>
              <button onClick={createInvoice} disabled={saving} className="btn-primary btn-sm inline-flex items-center gap-1.5 disabled:opacity-60">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />} Create draft
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject modal */}
      {rejecting && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => busyId == null && setRejecting(null)}>
          <div className="bg-[#0f1729] border border-white/10 rounded-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-white/10">
              <h2 className="text-lg font-semibold text-slate-100">Reject {rejecting.invoiceNumber}</h2>
            </div>
            <div className="p-6">
              <label className="block text-sm text-slate-400 mb-1.5">Reason (optional)</label>
              <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-slate-200" placeholder="Why is this being rejected?" />
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-white/10">
              <button onClick={() => setRejecting(null)} className="btn-ghost btn-sm">Cancel</button>
              <button onClick={() => act(rejecting, 'reject', rejectReason)} className="btn-primary btn-sm">Reject invoice</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
