'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Package, Loader2, AlertCircle, Search, Plus, X, ChevronRight, TrendingDown } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { formatMoney } from '@meritbooks/shared';
import { PageHeader } from '@/components/ui';

interface ItemRow {
  id: string;
  sku: string;
  name: string;
  uom: string;
  valuationMethod: 'WEIGHTED_AVG' | 'FIFO';
  qtyOnHand: number;
  avgCostCents: number;
  totalValueCents: number;
  reorderPoint: number | null;
  isActive: boolean;
}

interface ItemsResponse {
  data: ItemRow[];
  summary: { count: number; activeCount: number; totalValueCents: number; belowReorderCount: number };
  degraded?: boolean;
}

const METHOD_LABEL: Record<string, string> = { WEIGHTED_AVG: 'Wtd Avg', FIFO: 'FIFO' };

export default function InventoryPage() {
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, error, refetch } = useQuery<ItemsResponse>('/api/inventory/items');

  const items = data?.data ?? [];
  const summary = data?.summary;
  const filtered = search
    ? items.filter(
        (i) =>
          i.name.toLowerCase().includes(search.toLowerCase()) ||
          i.sku.toLowerCase().includes(search.toLowerCase()),
      )
    : items;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <PageHeader title="Inventory" description={`${summary?.count ?? 0} items · ${formatMoney(summary?.totalValueCents ?? 0)} on hand`} />
        <button
          onClick={() => setCreateOpen(true)}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-medium text-white"
        >
          <Plus size={14} /> New item
        </button>
      </div>

      {data?.degraded && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-300">
          Inventory schema is pending. Items and movements will appear once the migration is applied.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      ) : error ? (
        <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-red-400 text-sm">{error}</p></div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <div className="card p-4">
              <span className="text-xs text-slate-500 uppercase">On-hand value</span>
              <p className="text-xl font-mono font-semibold text-white mt-1">{formatMoney(summary?.totalValueCents ?? 0)}</p>
            </div>
            <div className="card p-4">
              <span className="text-xs text-slate-500 uppercase">Active items</span>
              <p className="text-xl font-mono font-semibold text-white mt-1">{summary?.activeCount ?? 0}</p>
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2"><TrendingDown size={14} className="text-amber-400" /><span className="text-xs text-slate-500 uppercase">Below reorder</span></div>
              <p className="text-xl font-mono font-semibold text-amber-400 mt-1">{summary?.belowReorderCount ?? 0}</p>
            </div>
          </div>

          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or SKU…"
              className="w-full bg-surface-900 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-600"
            />
          </div>

          {filtered.length === 0 ? (
            <div className="card p-10 text-center">
              <Package className="w-8 h-8 mx-auto text-slate-600 mb-3" />
              <p className="text-slate-400 text-sm">{items.length === 0 ? 'No inventory items yet.' : 'No items match your search.'}</p>
              {items.length === 0 && (
                <button onClick={() => setCreateOpen(true)} className="mt-3 text-emerald-400 text-sm hover:text-emerald-300">Create your first item</button>
              )}
            </div>
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-left text-xs uppercase text-slate-500">
                    <th className="px-4 py-2.5 font-medium">SKU</th>
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Method</th>
                    <th className="px-4 py-2.5 font-medium text-right">On hand</th>
                    <th className="px-4 py-2.5 font-medium text-right">Avg cost</th>
                    <th className="px-4 py-2.5 font-medium text-right">Value</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((i) => {
                    const low = i.reorderPoint != null && i.qtyOnHand <= i.reorderPoint;
                    return (
                      <tr key={i.id} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{i.sku}</td>
                        <td className="px-4 py-2.5 text-white">
                          <Link href={`/inventory/${i.id}`} className="hover:text-emerald-400">{i.name}</Link>
                          {!i.isActive && <span className="ml-2 text-xs text-slate-600">(inactive)</span>}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-slate-400">{METHOD_LABEL[i.valuationMethod]}</td>
                        <td className={clsx('px-4 py-2.5 text-right font-mono', low ? 'text-amber-400' : 'text-slate-200')}>
                          {i.qtyOnHand} <span className="text-slate-600">{i.uom}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-300">{formatMoney(i.avgCostCents)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-white">{formatMoney(i.totalValueCents)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <Link href={`/inventory/${i.id}`} className="text-slate-500 hover:text-emerald-400"><ChevronRight size={16} /></Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {createOpen && <CreateItemModal onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); refetch(); }} />}
    </div>
  );
}

function CreateItemModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [uom, setUom] = useState('each');
  const [method, setMethod] = useState<'WEIGHTED_AVG' | 'FIFO'>('WEIGHTED_AVG');
  const [reorder, setReorder] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setErr(null);
    const res = await api.post('/api/inventory/items', {
      sku: sku.trim(),
      name: name.trim(),
      uom: uom.trim() || 'each',
      valuation_method: method,
      reorder_point: reorder ? Number(reorder) : undefined,
    });
    setSaving(false);
    if (res.error) { setErr(res.error.error); return; }
    onCreated();
  }

  const valid = sku.trim().length > 0 && name.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-surface-900 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-semibold">New inventory item</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <Field label="SKU"><input value={sku} onChange={(e) => setSku(e.target.value)} className={inputCls} placeholder="WIDGET-001" /></Field>
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Standard widget" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Unit of measure"><input value={uom} onChange={(e) => setUom(e.target.value)} className={inputCls} placeholder="each" /></Field>
            <Field label="Reorder point"><input value={reorder} onChange={(e) => setReorder(e.target.value.replace(/[^0-9.]/g, ''))} className={inputCls} placeholder="optional" inputMode="decimal" /></Field>
          </div>
          <Field label="Valuation method">
            <select value={method} onChange={(e) => setMethod(e.target.value as 'WEIGHTED_AVG' | 'FIFO')} className={inputCls}>
              <option value="WEIGHTED_AVG">Weighted average</option>
              <option value="FIFO">FIFO</option>
            </select>
          </Field>
          {err && <p className="text-red-400 text-xs">{err}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-400 hover:text-white">Cancel</button>
          <button onClick={submit} disabled={!valid || saving} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg text-sm font-medium text-white">
            {saving && <Loader2 size={14} className="animate-spin" />} Create item
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls = 'w-full bg-surface-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-600';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-500 mb-1 block">{label}</span>
      {children}
    </label>
  );
}
