'use client';

/**
 * Pick an AP bill line for a unit cost (BILL_LINE source). Two steps over the
 * existing AP routes: search this client's bills by number (GET /api/bills), then
 * choose one of its lines (GET /api/bills/[id]). A bill-line id can also be pasted.
 */

import { useEffect, useId, useState } from 'react';
import { clsx } from 'clsx';
import { Loader2, Search } from 'lucide-react';
import { api } from '@/lib/api-client';
import { useDebounce } from '@/hooks/use-debounce';
import { dateLabel, money } from '@/lib/dealer/ui/format';
import { Field, Select, TextInput } from '../../_components/forms';

interface BillHit {
  id: string;
  bill_number: string;
  bill_date: string;
  total_cents: number;
  status: string;
  gl_entry_id?: string | null;
  vendor: { name?: string | null; display_name?: string | null } | null;
}

interface BillLine {
  id: string;
  line_number: number;
  description: string | null;
  amount_cents: number;
  account: { account_number: string; name: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function BillLinePicker({ locationId, value, onChange, error }: { locationId: string; value: string | null; onChange: (id: string | null) => void; error?: string }) {
  const id = useId();
  const [mode, setMode] = useState<'search' | 'paste'>('search');
  const [q, setQ] = useState('');
  const [paid, setPaid] = useState<'open' | 'PAID'>('open');
  const dq = useDebounce(q, 300);
  const [bills, setBills] = useState<BillHit[]>([]);
  const [loadingBills, setLoadingBills] = useState(false);
  const [billErr, setBillErr] = useState<string | null>(null);
  const [billId, setBillId] = useState<string | null>(null);
  const [lines, setLines] = useState<BillLine[]>([]);
  const [loadingLines, setLoadingLines] = useState(false);
  const [pasted, setPasted] = useState('');

  useEffect(() => {
    if (mode !== 'search') return;
    let cancelled = false;
    setLoadingBills(true);
    setBillErr(null);
    const params: Record<string, string> = { location_id: locationId, per_page: '20' };
    if (dq.trim()) params.search = dq.trim();
    if (paid === 'PAID') params.status = 'PAID';
    void api.get<{ data: BillHit[] }>('/api/bills', params).then((res) => {
      if (cancelled) return;
      setLoadingBills(false);
      if (res.error) {
        setBillErr('Bills couldn’t be loaded. Paste the bill line ID instead.');
        setBills([]);
        return;
      }
      setBills(res.data?.data ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [locationId, dq, paid, mode]);

  useEffect(() => {
    if (!billId) {
      setLines([]);
      return;
    }
    let cancelled = false;
    setLoadingLines(true);
    void api.get<{ lines: BillLine[] }>(`/api/bills/${billId}`).then((res) => {
      if (cancelled) return;
      setLoadingLines(false);
      setLines(res.data?.lines ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [billId]);

  return (
    <div className="space-y-3">
      <div className="flex gap-3 text-xs">
        <button type="button" onClick={() => setMode('search')} className={clsx(mode === 'search' ? 'text-white' : 'text-slate-500 hover:text-slate-300')} aria-pressed={mode === 'search'}>
          Find the bill
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('paste');
            onChange(UUID.test(pasted.trim()) ? pasted.trim() : null);
          }}
          className={clsx(mode === 'paste' ? 'text-white' : 'text-slate-500 hover:text-slate-300')}
          aria-pressed={mode === 'paste'}
        >
          Paste a bill line ID
        </button>
      </div>

      {mode === 'paste' ? (
        <Field label="Bill line ID" htmlFor={`${id}-paste`} required error={error} hint="From the bill’s line detail.">
          <TextInput
            id={`${id}-paste`}
            value={pasted}
            onChange={(v) => {
              setPasted(v);
              onChange(UUID.test(v.trim()) ? v.trim() : null);
            }}
            className="font-mono"
            invalid={!!error || (pasted.trim() !== '' && !UUID.test(pasted.trim()))}
          />
        </Field>
      ) : (
        <>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <label htmlFor={`${id}-q`} className="sr-only">
                Search bills by number
              </label>
              <input id={`${id}-q`} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Bill number…" className="input w-full pl-8" />
            </div>
            <div className="w-32">
              <Select<'open' | 'PAID'>
                aria-label="Bill status"
                value={paid}
                onChange={(v) => {
                  setPaid(v);
                  setBillId(null);
                  onChange(null);
                }}
                options={[
                  { value: 'open', label: 'Open bills' },
                  { value: 'PAID', label: 'Paid bills' },
                ]}
              />
            </div>
          </div>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-800" role="listbox" aria-label="Bills">
            {loadingBills ? (
              <p className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500" role="status">
                <Loader2 size={12} className="animate-spin" /> Searching…
              </p>
            ) : billErr ? (
              <p className="px-3 py-2 text-xs text-amber-300">{billErr}</p>
            ) : bills.length === 0 ? (
              <p className="px-3 py-2 text-xs text-slate-500">No bills found for this client.</p>
            ) : (
              bills.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="option"
                  aria-selected={billId === b.id}
                  onClick={() => {
                    setBillId(b.id);
                    onChange(null);
                  }}
                  className={clsx('flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-body-sm hover:bg-white/[0.03]', billId === b.id && 'bg-slate-800/60')}
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono tabular-nums text-white">{b.bill_number}</span>
                    <span className="ml-2 text-slate-400">{b.vendor?.display_name ?? b.vendor?.name ?? ''}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-slate-400">
                    {dateLabel(b.bill_date)} · {money(b.total_cents)}
                  </span>
                </button>
              ))
            )}
          </div>
          {billId && (
            <Field label="Bill line" htmlFor={`${id}-line`} required error={error} hint="Pick the line coded to this unit’s inventory account.">
              {loadingLines ? (
                <p className="text-xs text-slate-500" role="status">Loading lines…</p>
              ) : (
                <Select<string>
                  id={`${id}-line`}
                  value={value ?? ''}
                  onChange={(v) => onChange(v || null)}
                  placeholder="Choose a line…"
                  invalid={!!error}
                  options={lines.map((l) => ({
                    value: l.id,
                    label: `#${l.line_number} ${l.description ?? ''} — ${l.account ? `${l.account.account_number} ${l.account.name}` : 'no account'} — ${money(l.amount_cents)}`,
                  }))}
                />
              )}
            </Field>
          )}
        </>
      )}
    </div>
  );
}
