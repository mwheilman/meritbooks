'use client';

import { useCallback, useEffect, useState } from 'react';
import { Landmark, Loader2, Pencil, Check, X } from 'lucide-react';

interface BankAccount {
  id: string;
  label: string;
  mask: string | null;
  type: string;
  locationId: string;
  locationName: string;
  glAccountId: string;
  glAccountLabel: string;
}
interface GlOption { id: string; account_number: string; name: string; account_type: string; company_location_id: string | null }

/**
 * Lists connected bank accounts and lets the user rename them and reselect the
 * GL account they post to (the "come back into feed and edit" requirement).
 * Entity is shown but not editable here.
 */
export function BankAccountManager({ refreshKey }: { refreshKey?: number }) {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [glOptions, setGlOptions] = useState<GlOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ label: string; glAccountId: string }>({ label: '', glAccountId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/bank-accounts', { method: 'GET' });
      const body = (await res.json()) as { accounts?: BankAccount[]; glOptions?: GlOption[]; error?: string };
      if (res.ok) {
        setAccounts(body.accounts ?? []);
        setGlOptions(body.glOptions ?? []);
      } else {
        setError(body.error ?? 'Could not load accounts.');
      }
    } catch {
      setError('Network error loading accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const startEdit = (a: BankAccount) => {
    setEditId(a.id);
    setDraft({ label: a.label, glAccountId: a.glAccountId });
    setError(null);
  };

  const save = useCallback(async (a: BankAccount) => {
    if (!draft.label.trim()) { setError('Label cannot be empty.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bank-accounts/${a.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: draft.label.trim(), gl_account_id: draft.glAccountId }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok || body.error) setError(body.error ?? 'Save failed.');
      else { setEditId(null); await load(); }
    } catch {
      setError('Network error saving.');
    } finally {
      setBusy(false);
    }
  }, [draft, load]);

  if (loading) return <div className="flex items-center gap-2 text-xs text-slate-500 py-2"><Loader2 size={12} className="animate-spin" /> Loading accounts…</div>;
  if (accounts.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {error && <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
      {accounts.map((a) => {
        const editing = editId === a.id;
        const opts = glOptions.filter((g) => !g.company_location_id || g.company_location_id === a.locationId);
        return (
          <div key={a.id} className="rounded-lg bg-slate-800/30 border border-slate-800 px-3 py-2">
            {!editing ? (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Landmark size={13} className="text-slate-400 shrink-0" />
                  <span className="text-sm text-slate-200 truncate">{a.label}</span>
                  <span className="text-[10px] font-mono text-slate-500 shrink-0">····{a.mask ?? '—'} · {a.locationName} · GL {a.glAccountLabel}</span>
                </div>
                <button onClick={() => startEdit(a)} className="text-slate-500 hover:text-slate-300 shrink-0" aria-label="Edit account"><Pencil size={13} /></button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <input
                    value={draft.label}
                    onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                    className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white"
                    aria-label="Account label"
                  />
                  <select
                    value={draft.glAccountId}
                    onChange={(e) => setDraft((d) => ({ ...d, glAccountId: e.target.value }))}
                    className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white"
                    aria-label="GL account"
                  >
                    {opts.map((g) => <option key={g.id} value={g.id}>{g.account_number} · {g.name}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2 justify-end">
                  <button onClick={() => setEditId(null)} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50"><X size={12} /> Cancel</button>
                  <button onClick={() => save(a)} disabled={busy} className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-500 text-slate-900 text-xs font-medium hover:bg-emerald-400 disabled:opacity-50">
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
