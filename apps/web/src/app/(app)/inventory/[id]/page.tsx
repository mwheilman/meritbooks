'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Loader2, AlertCircle, PackagePlus, PackageMinus, Scale, CheckCircle2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { formatMoney } from '@meritbooks/shared';
import { PageHeader } from '@/components/ui';

interface Movement {
  id: string;
  type: 'RECEIPT' | 'ISSUE' | 'ADJUST';
  status: 'PROPOSED' | 'POSTED' | 'VOID';
  qty: number;
  unitCostCents: number;
  totalCostCents: number;
  cogsCents: number;
  reference: string | null;
  memo: string | null;
  movementDate: string;
  glEntryId: string | null;
}

interface ItemDetail {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  uom: string;
  valuationMethod: 'WEIGHTED_AVG' | 'FIFO';
  qtyOnHand: number;
  avgCostCents: number;
  totalValueCents: number;
  reorderPoint: number | null;
  isActive: boolean;
  movements: Movement[];
}

const TYPE_META: Record<string, { label: string; cls: string }> = {
  RECEIPT: { label: 'Receipt', cls: 'text-emerald-400' },
  ISSUE: { label: 'Issue', cls: 'text-red-400' },
  ADJUST: { label: 'Adjust', cls: 'text-amber-400' },
};
const STATUS_CLS: Record<string, string> = {
  PROPOSED: 'bg-amber-500/10 text-amber-400',
  POSTED: 'bg-emerald-500/10 text-emerald-400',
  VOID: 'bg-slate-500/10 text-slate-500',
};

export default function InventoryItemPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id as string;
  const { data, isLoading, error, refetch } = useQuery<{ data: ItemDetail }>(id ? `/api/inventory/items/${id}` : null);
  const [action, setAction] = useState<'RECEIPT' | 'ISSUE' | 'ADJUST'>('RECEIPT');
  const item = data?.data;

  return (
    <div className="space-y-6">
      <Link href="/inventory" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300"><ArrowLeft size={14} /> Inventory</Link>

      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      ) : error || !item ? (
        <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-red-400 text-sm">{error ?? 'Item not found'}</p></div>
      ) : (
        <>
          <PageHeader title={item.name} description={`${item.sku} · ${item.valuationMethod === 'FIFO' ? 'FIFO' : 'Weighted average'}`} />

          <div className="grid grid-cols-3 gap-4">
            <Metric label="On hand" value={`${item.qtyOnHand} ${item.uom}`} />
            <Metric label="Avg cost" value={formatMoney(item.avgCostCents)} />
            <Metric label="Inventory value" value={formatMoney(item.totalValueCents)} accent />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Action panel */}
            <div className="card p-4 h-fit">
              <div className="flex gap-1 mb-4 border-b border-slate-800">
                {(['RECEIPT', 'ISSUE', 'ADJUST'] as const).map((t) => (
                  <button key={t} onClick={() => setAction(t)}
                    className={clsx('px-2.5 py-2 text-xs font-medium border-b-2 -mb-px',
                      action === t ? 'border-emerald-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300')}>
                    {TYPE_META[t].label}
                  </button>
                ))}
              </div>
              <MovementForm itemId={item.id} uom={item.uom} action={action} onDone={refetch} />
            </div>

            {/* Movement history */}
            <div className="lg:col-span-2 card overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 text-xs uppercase text-slate-500">Movement history</div>
              {item.movements.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">No movements yet.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-xs uppercase text-slate-500">
                      <th className="px-4 py-2 font-medium">Date</th>
                      <th className="px-4 py-2 font-medium">Type</th>
                      <th className="px-4 py-2 font-medium text-right">Qty</th>
                      <th className="px-4 py-2 font-medium text-right">COGS</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {item.movements.map((m) => (
                      <MovementRow key={m.id} m={m} onPosted={refetch} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MovementRow({ m, onPosted }: { m: Movement; onPosted: () => void }) {
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function approve() {
    setPosting(true);
    setErr(null);
    const res = await api.post(`/api/inventory/movements/${m.id}/approve`, {});
    setPosting(false);
    if (res.error) { setErr(res.error.error); return; }
    onPosted();
  }

  return (
    <tr className="border-b border-slate-800/60">
      <td className="px-4 py-2.5 text-xs font-mono text-slate-400">{m.movementDate}</td>
      <td className={clsx('px-4 py-2.5 text-xs font-medium', TYPE_META[m.type].cls)}>{TYPE_META[m.type].label}</td>
      <td className="px-4 py-2.5 text-right font-mono text-slate-200">{m.qty}</td>
      <td className="px-4 py-2.5 text-right font-mono text-slate-300">{m.type === 'RECEIPT' ? '—' : formatMoney(m.cogsCents)}</td>
      <td className="px-4 py-2.5">
        <span className={clsx('inline-block rounded px-1.5 py-0.5 text-xs', STATUS_CLS[m.status])}>{m.status}</span>
        {err && <p className="text-red-400 text-xs mt-1">{err}</p>}
      </td>
      <td className="px-4 py-2.5 text-right">
        {m.status === 'PROPOSED' && (
          <button onClick={approve} disabled={posting}
            className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded text-xs font-medium text-white">
            {posting ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Approve & post
          </button>
        )}
      </td>
    </tr>
  );
}

function MovementForm({ itemId, uom, action, onDone }: { itemId: string; uom: string; action: 'RECEIPT' | 'ISSUE' | 'ADJUST'; onDone: () => void }) {
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const needsCost = action === 'RECEIPT' || (action === 'ADJUST' && Number(qty) > 0);

  async function submit() {
    setSaving(true); setErr(null); setOk(null);
    const qtyNum = Number(qty);
    const body: Record<string, unknown> = { type: action, item_id: itemId, qty: qtyNum, memo: memo.trim() || undefined };
    if (action === 'RECEIPT') body.total_cost_cents = Math.round(Number(cost) * 100);
    if (action === 'ADJUST' && qtyNum > 0) body.unit_cost_cents = Math.round(Number(cost) * 100);
    const res = await api.post('/api/inventory/movements', body);
    setSaving(false);
    if (res.error) { setErr(res.error.error); return; }
    setQty(''); setCost(''); setMemo('');
    setOk(action === 'RECEIPT' ? 'Received.' : 'Proposed — approve it in the history to post COGS.');
    onDone();
  }

  const Icon = action === 'RECEIPT' ? PackagePlus : action === 'ISSUE' ? PackageMinus : Scale;
  const valid = qty !== '' && Number(qty) !== 0 && (!needsCost || cost !== '');

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        {action === 'RECEIPT' && 'Increases on-hand and value. No GL entry — the bill or cash entry books the asset.'}
        {action === 'ISSUE' && 'Removes stock and computes COGS. Posts DR COGS / CR Inventory after you approve it.'}
        {action === 'ADJUST' && 'Signed count correction (+ write-up needs a unit cost, − is shrinkage). Posts after approval.'}
      </p>
      <label className="block">
        <span className="text-xs text-slate-500 mb-1 block">Quantity {action === 'ADJUST' ? '(signed, e.g. -3)' : `(${uom})`}</span>
        <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9.\-]/g, ''))} inputMode="decimal"
          className="w-full bg-surface-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-600" placeholder="0" />
      </label>
      {needsCost && (
        <label className="block">
          <span className="text-xs text-slate-500 mb-1 block">{action === 'RECEIPT' ? 'Total cost ($)' : 'Unit cost ($)'}</span>
          <input value={cost} onChange={(e) => setCost(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal"
            className="w-full bg-surface-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-600" placeholder="0.00" />
        </label>
      )}
      <label className="block">
        <span className="text-xs text-slate-500 mb-1 block">Memo (optional)</span>
        <input value={memo} onChange={(e) => setMemo(e.target.value)}
          className="w-full bg-surface-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-600" placeholder="Reference / note" />
      </label>
      {err && <p className="text-red-400 text-xs">{err}</p>}
      {ok && <p className="text-emerald-400 text-xs">{ok}</p>}
      <button onClick={submit} disabled={!valid || saving}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg text-sm font-medium text-white">
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
        {action === 'RECEIPT' ? 'Record receipt' : action === 'ISSUE' ? 'Propose issue' : 'Propose adjustment'}
      </button>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card p-4">
      <span className="text-xs text-slate-500 uppercase">{label}</span>
      <p className={clsx('text-xl font-mono font-semibold mt-1', accent ? 'text-emerald-400' : 'text-white')}>{value}</p>
    </div>
  );
}
