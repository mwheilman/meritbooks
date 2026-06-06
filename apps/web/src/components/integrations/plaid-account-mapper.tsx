'use client';

import { useCallback, useEffect, useState } from 'react';
import { Landmark, Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { clsx } from 'clsx';

interface PendingAccount {
  id: string;
  plaidAccountId: string;
  accountName: string;
  accountMask: string | null;
  accountType: string;
  currentBalanceCents: number | null;
  locationId: string;
  status: string;
}
interface Entity { id: string; name: string; short_code: string }
interface GlAccount { id: string; account_number: string; name: string; account_type: string; is_bank_account: boolean; company_location_id: string | null }

interface MapData { pending: PendingAccount[]; entities: Entity[]; glAccounts: GlAccount[] }

function dollars(cents: number | null): string {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * Shown after a Plaid connect. The entity is already fixed (resolved before
 * Plaid opened), so for each staged account the user only picks a GL cash
 * account and a label, then clicks "Add account" (or "Ignore"). Mapping promotes
 * it into a real bank account and pulls transactions. Calls onDone() when nothing
 * is left to map.
 */
export function PlaidAccountMapper({ onDone }: { onDone?: () => void }) {
  const [data, setData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, { glAccountId: string; label: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/plaid/map', { method: 'GET' });
      const body = (await res.json()) as MapData & { error?: string };
      if (!res.ok) {
        setError(body.error ?? 'Could not load accounts to map.');
      } else {
        setData(body);
        setDrafts((prev) => {
          const next = { ...prev };
          for (const p of body.pending) {
            if (!next[p.id]) next[p.id] = { glAccountId: '', label: p.accountName };
          }
          return next;
        });
      }
    } catch {
      setError('Network error loading accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setDraft = (id: string, patch: Partial<{ glAccountId: string; label: string }>) =>
    setDrafts((p) => ({ ...p, [id]: { ...p[id], ...patch } }));

  const doMap = useCallback(async (p: PendingAccount) => {
    const d = drafts[p.id];
    if (!d?.glAccountId || !d?.label.trim()) {
      setError('Pick a GL account and a label first.');
      return;
    }
    setBusyId(p.id);
    setError(null);
    try {
      const res = await fetch('/api/integrations/plaid/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'map', pending_id: p.id, gl_account_id: d.glAccountId, label: d.label.trim() }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok || body.error) setError(body.error ?? 'Failed to map account.');
      else await load();
    } catch {
      setError('Network error mapping account.');
    } finally {
      setBusyId(null);
    }
  }, [drafts, load]);

  const doIgnore = useCallback(async (p: PendingAccount) => {
    setBusyId(p.id);
    try {
      await fetch('/api/integrations/plaid/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ignore', pending_id: p.id }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }, [load]);

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-slate-400 py-4"><Loader2 size={14} className="animate-spin" /> Loading accounts…</div>;
  }
  if (!data || data.pending.length === 0) {
    // Nothing left to map.
    return null;
  }

  return (
    <div className="space-y-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-white">Assign your bank accounts</p>
        <button onClick={() => onDone?.()} className="text-slate-500 hover:text-slate-300" aria-label="Done mapping"><X size={16} /></button>
      </div>
      <p className="text-xs text-slate-400">For each account, choose the entity, the GL account it posts to, and a label. Accounts you don&apos;t track (loans, personal) can be ignored.</p>

      {error && (
        <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2" role="status">
          <AlertCircle size={14} className="shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}

      <div className="space-y-2">
        {data.pending.map((p) => {
          const d = drafts[p.id] ?? { glAccountId: '', label: p.accountName };
          const entity = data.entities.find((e) => e.id === p.locationId);
          // GL options: asset/bank accounts org-wide or scoped to this account's entity.
          const glOpts = data.glAccounts.filter((g) => !g.company_location_id || g.company_location_id === p.locationId);
          const busy = busyId === p.id;
          return (
            <div key={p.id} className="rounded-lg bg-slate-800/40 border border-slate-800 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Landmark size={14} className="text-slate-400 shrink-0" />
                  <span className="text-sm text-slate-200 truncate">{p.accountName}</span>
                  <span className="text-[10px] font-mono text-slate-500 shrink-0">····{p.accountMask ?? '—'} · {p.accountType} · {dollars(p.currentBalanceCents)}</span>
                </div>
                <span className="text-[10px] text-slate-400 bg-slate-700/40 rounded px-2 py-0.5 shrink-0">{entity?.name ?? 'Entity'}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <select
                  value={d.glAccountId}
                  onChange={(e) => setDraft(p.id, { glAccountId: e.target.value })}
                  className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white"
                  aria-label="GL account"
                >
                  <option value="">Select GL account…</option>
                  {glOpts.map((g) => <option key={g.id} value={g.id}>{g.account_number} · {g.name}</option>)}
                </select>
                <input
                  value={d.label}
                  onChange={(e) => setDraft(p.id, { label: e.target.value })}
                  placeholder="Label"
                  className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white"
                  aria-label="Account label"
                />
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button onClick={() => doIgnore(p)} disabled={busy} className="px-2.5 py-1 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50">Ignore</button>
                <button onClick={() => doMap(p)} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-500 text-slate-900 text-xs font-medium hover:bg-emerald-400 disabled:opacity-50">
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Add account
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
