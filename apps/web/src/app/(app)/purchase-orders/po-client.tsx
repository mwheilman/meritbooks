'use client';

/**
 * Purchase Orders (GATE 11b) — general vendor procurement + 3-way match.
 *
 *   • List — every PO with status + ordered/received/billed roll-ups.
 *   • Create — pick a vendor, add lines (GL account, qty, unit cost); Books mints
 *     the PO number.
 *   • Detail drawer — lines with ordered/received/billed, record a goods receipt,
 *     and run the 3-way match against a vendor bill. A mismatch is quantified and
 *     (server-side) queued to /exceptions for a human; a clean match is MATCHED.
 *
 * Never pays. All money is cents; the UI converts dollar inputs at the boundary.
 */

import { useMemo, useState } from 'react';
import {
  ClipboardList, Plus, Loader2, AlertCircle, X, Trash2, PackageCheck, GitCompareArrows, ChevronRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader, EmptyState, StatusBadge } from '@/components/ui';
import type { ThreeWayMatchResult } from '@/lib/procurement/three-way-match';
import { BillMatchPanel } from './bill-match-panel';

// ── Types ────────────────────────────────────────────────────────────────────
type PoStatus = 'DRAFT' | 'OPEN' | 'PARTIAL' | 'CLOSED' | 'CANCELLED';

interface PoListItem {
  id: string;
  po_number: string;
  vendor_name: string;
  status: PoStatus;
  order_date: string;
  total_cents: number;
  received_total_cents: number;
  billed_total_cents: number;
}
interface Vendor { id: string; name: string; display_name?: string | null }
interface Account { id: string; accountNumber: string; name: string; accountType: string }
interface BillLite { id: string; bill_number: string | null; total_cents: number; vendor_id: string }

interface PoLine {
  id: string; line_number: number; description: string | null;
  account_id: string | null; account_number: string | null; account_name: string | null;
  quantity: number; unit_cost_cents: number; amount_cents: number;
  received_qty: number; billed_qty: number;
}
interface Receipt { id: string; receipt_number: string | null; received_date: string; notes: string | null }
interface BillLink {
  id: string; bill_id: string; match_status: string;
  match_result: ThreeWayMatchResult | null; exception_decision_id: string | null; matched_at: string | null;
}
interface PoDetail {
  purchase_order: PoListItem & { vendor_id: string; memo: string | null; expected_date: string | null; subtotal_cents: number; tax_cents: number };
  lines: PoLine[];
  receipts: Receipt[];
  bill_links: BillLink[];
}

const fmt = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtQty = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(2));
const dollarsToCents = (s: string) => Math.round((parseFloat(s) || 0) * 100);

// ─────────────────────────────────────────────────────────────────────────────
export function PoClient() {
  const [showCreate, setShowCreate] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const { data, isLoading, error } = useQuery<{ purchase_orders: PoListItem[] }>(
    '/api/purchase-orders',
    undefined,
    { key: String(reloadKey) },
  );
  const pos = data?.purchase_orders ?? [];
  const refresh = () => setReloadKey((k) => k + 1);

  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        description="General vendor procurement with 3-way match (PO → goods receipt → bill)."
        actions={
          <button className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> New PO
          </button>
        }
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <AlertCircle size={16} /> {error}
        </div>
      ) : pos.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No purchase orders yet"
          description="Raise a PO to commit spend with a vendor, then receive against it and 3-way-match the bill before it is paid."
          action={{ label: 'Create purchase order', onClick: () => setShowCreate(true) }}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-surface-950 text-2xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">PO #</th>
                <th className="px-4 py-2.5 text-left font-medium">Vendor</th>
                <th className="px-4 py-2.5 text-left font-medium">Date</th>
                <th className="px-4 py-2.5 text-right font-medium">Ordered</th>
                <th className="px-4 py-2.5 text-right font-medium">Received</th>
                <th className="px-4 py-2.5 text-right font-medium">Billed</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {pos.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setOpenId(p.id)}
                  className="cursor-pointer border-t border-slate-800/60 hover:bg-surface-950/60"
                >
                  <td className="px-4 py-2.5 font-mono text-slate-200">{p.po_number}</td>
                  <td className="px-4 py-2.5 text-slate-300">{p.vendor_name}</td>
                  <td className="px-4 py-2.5 text-slate-400">{p.order_date}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-200">{fmt(p.total_cents)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-400">{fmt(p.received_total_cents)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-400">{fmt(p.billed_total_cents)}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={p.status} /></td>
                  <td className="px-4 py-2.5 text-slate-600"><ChevronRight size={15} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreatePoModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); refresh(); }}
        />
      )}
      {openId && (
        <PoDetailDrawer
          poId={openId}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

// ── Create modal ─────────────────────────────────────────────────────────────
interface DraftLine { description: string; account_id: string; quantity: string; unit_cost: string }
const emptyLine = (): DraftLine => ({ description: '', account_id: '', quantity: '1', unit_cost: '' });

function CreatePoModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { data: vendorData } = useQuery<{ vendors: Vendor[] }>('/api/vendors');
  const { data: acctData } = useQuery<{ data: Account[] }>('/api/accounts');
  const vendors = vendorData?.vendors ?? [];
  const accounts = useMemo(
    () => (acctData?.data ?? []).filter((a) => ['COGS', 'OPEX', 'ASSET'].includes(a.accountType)),
    [acctData],
  );

  const [vendorId, setVendorId] = useState('');
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);

  const subtotal = lines.reduce((s, l) => s + Math.round((parseFloat(l.quantity) || 0) * dollarsToCents(l.unit_cost)), 0);
  const valid = vendorId && lines.every((l) => l.account_id && (parseFloat(l.quantity) || 0) > 0);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  async function submit() {
    if (!valid) return;
    setSubmitting(true);
    const res = await api.post<{ po_number: string }>('/api/purchase-orders', {
      vendor_id: vendorId,
      order_date: orderDate,
      expected_date: expectedDate || null,
      memo: memo || undefined,
      status: 'OPEN',
      lines: lines.map((l) => ({
        description: l.description || undefined,
        account_id: l.account_id,
        quantity: parseFloat(l.quantity) || 0,
        unit_cost_cents: dollarsToCents(l.unit_cost),
      })),
    });
    setSubmitting(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `Created ${res.data?.po_number}`);
    onCreated();
  }

  return (
    <Drawer title="New purchase order" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendor">
            <select className="input-field" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Select vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.display_name || v.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Order date">
            <input type="date" className="input-field" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
          </Field>
          <Field label="Expected date">
            <input type="date" className="input-field" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
          </Field>
          <Field label="Memo">
            <input className="input-field" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
          </Field>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-2xs uppercase tracking-wide text-slate-500">Lines</span>
            <button className="text-xs text-emerald-400 hover:text-emerald-300" onClick={() => setLines((l) => [...l, emptyLine()])}>
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.4fr_70px_90px_auto] items-center gap-2">
                <input
                  className="input-field"
                  placeholder="Description"
                  value={l.description}
                  onChange={(e) => setLine(i, { description: e.target.value })}
                />
                <select className="input-field" value={l.account_id} onChange={(e) => setLine(i, { account_id: e.target.value })}>
                  <option value="">GL account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>
                  ))}
                </select>
                <input
                  className="input-field text-right"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Qty"
                  value={l.quantity}
                  onChange={(e) => setLine(i, { quantity: e.target.value })}
                />
                <input
                  className="input-field text-right"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="$/unit"
                  value={l.unit_cost}
                  onChange={(e) => setLine(i, { unit_cost: e.target.value })}
                />
                <button
                  className="text-slate-600 hover:text-red-400 disabled:opacity-30"
                  disabled={lines.length === 1}
                  onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 pt-3">
          <span className="text-sm text-slate-400">Subtotal</span>
          <span className="font-mono text-base text-white">{fmt(subtotal)}</span>
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm inline-flex items-center gap-1.5" disabled={!valid || submitting} onClick={submit}>
            {submitting && <Loader2 className="animate-spin" size={14} />} Create PO
          </button>
        </div>
      </div>
    </Drawer>
  );
}

// ── Detail drawer ────────────────────────────────────────────────────────────
function PoDetailDrawer({ poId, onClose, onChanged }: { poId: string; onClose: () => void; onChanged: () => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  const { data, isLoading, error } = useQuery<PoDetail>(`/api/purchase-orders/${poId}`, undefined, { key: String(reloadKey) });
  const [receiving, setReceiving] = useState(false);
  const [matching, setMatching] = useState(false);

  const reload = () => { setReloadKey((k) => k + 1); onChanged(); };

  const po = data?.purchase_order;

  return (
    <Drawer title={po ? po.po_number : 'Purchase order'} onClose={onClose} wide>
      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>
      ) : error || !data || !po ? (
        <div className="flex items-center gap-2 text-sm text-red-300"><AlertCircle size={16} /> {error ?? 'Not found'}</div>
      ) : (
        <div className="space-y-5">
          {/* Header meta */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div><span className="text-slate-500">Vendor</span> <span className="text-slate-200">{po.vendor_name}</span></div>
            <div><span className="text-slate-500">Status</span> <StatusBadge status={po.status} /></div>
            <div><span className="text-slate-500">Ordered</span> <span className="font-mono text-slate-200">{fmt(po.total_cents)}</span></div>
            <div><span className="text-slate-500">Received</span> <span className="font-mono text-slate-300">{fmt(po.received_total_cents)}</span></div>
            <div><span className="text-slate-500">Billed</span> <span className="font-mono text-slate-300">{fmt(po.billed_total_cents)}</span></div>
          </div>

          {/* Lines */}
          <section>
            <h3 className="mb-2 text-2xs uppercase tracking-wide text-slate-500">Lines</h3>
            <div className="overflow-hidden rounded-lg border border-slate-800">
              <table className="w-full text-xs">
                <thead className="bg-surface-950 text-2xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="px-3 py-2 text-left font-medium">Account</th>
                    <th className="px-3 py-2 text-right font-medium">Ordered</th>
                    <th className="px-3 py-2 text-right font-medium">Received</th>
                    <th className="px-3 py-2 text-right font-medium">Billed</th>
                    <th className="px-3 py-2 text-right font-medium">Unit</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.id} className="border-t border-slate-800/60">
                      <td className="px-3 py-2 text-slate-300">{l.description ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-400">{l.account_number ? `${l.account_number} · ${l.account_name}` : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-300">{fmtQty(l.quantity)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400">{fmtQty(l.received_qty)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400">{fmtQty(l.billed_qty)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400">{fmt(l.unit_cost_cents)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-200">{fmt(l.amount_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              className="btn-ghost btn-sm inline-flex items-center gap-1.5"
              disabled={po.status === 'CANCELLED' || po.status === 'CLOSED'}
              onClick={() => setReceiving((v) => !v)}
            >
              <PackageCheck size={14} /> Receive goods
            </button>
            <button
              className="btn-ghost btn-sm inline-flex items-center gap-1.5"
              onClick={() => setMatching((v) => !v)}
            >
              <GitCompareArrows size={14} /> 3-way match a bill
            </button>
          </div>

          {receiving && (
            <ReceiveForm poId={poId} lines={data.lines} onDone={() => { setReceiving(false); reload(); }} />
          )}
          {matching && (
            <MatchForm poId={poId} vendorId={po.vendor_id} onDone={reload} />
          )}

          {/* Receipts */}
          {data.receipts.length > 0 && (
            <section>
              <h3 className="mb-2 text-2xs uppercase tracking-wide text-slate-500">Goods receipts</h3>
              <ul className="space-y-1 text-xs">
                {data.receipts.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-slate-400">
                    <PackageCheck size={13} className="text-emerald-500" />
                    {r.received_date}{r.receipt_number ? ` · ${r.receipt_number}` : ''}{r.notes ? ` — ${r.notes}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Existing matched bills */}
          {data.bill_links.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-2xs uppercase tracking-wide text-slate-500">Matched bills</h3>
              {data.bill_links.map((link) => (
                <div key={link.id}>
                  <div className="mb-1 flex items-center gap-2 text-xs text-slate-400">
                    <StatusBadge status={link.match_status} />
                    {link.exception_decision_id && (
                      <a href="/exceptions" className="text-amber-400 hover:text-amber-300">→ queued on Needs Attention</a>
                    )}
                  </div>
                  {link.match_result && <BillMatchPanel result={link.match_result} />}
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ── Receive form ─────────────────────────────────────────────────────────────
function ReceiveForm({ poId, lines, onDone }: { poId: string; lines: PoLine[]; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, String(Math.max(0, l.quantity - l.received_qty))])),
  );
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const rlines = lines
      .map((l) => ({ po_line_id: l.id, quantity_received: parseFloat(qty[l.id]) || 0 }))
      .filter((l) => l.quantity_received > 0);
    if (rlines.length === 0) { addToast('error', 'Enter at least one received quantity.'); return; }
    setBusy(true);
    const res = await api.post('/api/goods-receipts', { po_id: poId, notes: notes || undefined, lines: rlines });
    setBusy(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Goods receipt recorded.');
    onDone();
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-surface-950 p-3 space-y-2">
      <h4 className="text-xs font-medium text-slate-300">Record goods receipt</h4>
      {lines.map((l) => (
        <div key={l.id} className="grid grid-cols-[1fr_100px] items-center gap-2 text-xs">
          <span className="text-slate-400 truncate">
            {l.description ?? l.account_name ?? 'Line'} <span className="text-slate-600">(ordered {fmtQty(l.quantity)}, received {fmtQty(l.received_qty)})</span>
          </span>
          <input
            type="number" min="0" step="any" className="input-field text-right"
            value={qty[l.id] ?? ''}
            onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))}
          />
        </div>
      ))}
      <input className="input-field" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="flex justify-end">
        <button className="btn-primary btn-sm inline-flex items-center gap-1.5" disabled={busy} onClick={submit}>
          {busy && <Loader2 className="animate-spin" size={14} />} Save receipt
        </button>
      </div>
    </div>
  );
}

// ── Match form ───────────────────────────────────────────────────────────────
function MatchForm({ poId, vendorId, onDone }: { poId: string; vendorId: string; onDone: () => void }) {
  const { data: billData } = useQuery<{ data: BillLite[] }>('/api/bills', { status: 'all', per_page: '100' });
  const bills = useMemo(() => (billData?.data ?? []).filter((b) => b.vendor_id === vendorId), [billData, vendorId]);
  const [billId, setBillId] = useState('');
  const [tolerance, setTolerance] = useState('5');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ThreeWayMatchResult | null>(null);

  async function run() {
    if (!billId) return;
    setBusy(true);
    const res = await api.post<{ verdict: string; result: ThreeWayMatchResult }>(
      `/api/purchase-orders/${poId}/match`,
      { bill_id: billId, price_tolerance_pct: parseFloat(tolerance) || undefined },
    );
    setBusy(false);
    if (res.error) { addToast('error', res.error.error); return; }
    setResult(res.data?.result ?? null);
    addToast(res.data?.verdict === 'PASS' ? 'success' : 'info',
      res.data?.verdict === 'PASS' ? 'Match clean — bill reconciles.' : 'Exception queued for review.');
    onDone();
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-surface-950 p-3 space-y-3">
      <h4 className="text-xs font-medium text-slate-300">Run 3-way match</h4>
      <div className="grid grid-cols-[1fr_120px_auto] items-end gap-2">
        <Field label="Vendor bill">
          <select className="input-field" value={billId} onChange={(e) => setBillId(e.target.value)}>
            <option value="">Select bill…</option>
            {bills.map((b) => (
              <option key={b.id} value={b.id}>{b.bill_number ?? b.id.slice(0, 8)} · {fmt(b.total_cents)}</option>
            ))}
          </select>
        </Field>
        <Field label="Price tol %">
          <input type="number" min="0" step="0.5" className="input-field text-right" value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
        </Field>
        <button className="btn-primary btn-sm inline-flex items-center gap-1.5" disabled={!billId || busy} onClick={run}>
          {busy && <Loader2 className="animate-spin" size={14} />} Match
        </button>
      </div>
      {bills.length === 0 && <p className="text-2xs text-slate-500">No bills found for this vendor. Create the bill first, then match it here.</p>}
      {result && <BillMatchPanel result={result} />}
    </div>
  );
}

// ── Small shared bits ────────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-2xs uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Drawer({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className={clsx('relative h-full overflow-y-auto border-l border-slate-800 bg-surface-900 p-6', wide ? 'w-full max-w-3xl' : 'w-full max-w-xl')}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button className="text-slate-500 hover:text-slate-300" onClick={onClose}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
