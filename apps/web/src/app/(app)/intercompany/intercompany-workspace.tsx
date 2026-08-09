'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Loader2, AlertCircle, Plus, Combine, X, Ban, CheckCircle2, AlertTriangle, ArrowRight, Search,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { EmptyState } from '@/components/ui';

type Nature = 'FUNDING' | 'EXPENSE_ON_BEHALF' | 'REPAYMENT';
type Status = 'POSTED' | 'VOIDED';

interface Entity { id: string; name: string; shortCode: string | null }
interface TxnRow {
  id: string;
  icNumber: string;
  nature: Nature;
  transactionDate: string;
  fromEntity: Entity | null;
  toEntity: Entity | null;
  amountCents: number;
  memo: string | null;
  status: Status;
  fromEntryNumber: string | null;
  toEntryNumber: string | null;
}
interface PairBalance { creditorEntity: Entity; debtorEntity: Entity; netCents: number }
interface GroupTie { totalReceivableCents: number; totalPayableCents: number; differenceCents: number; balanced: boolean }
interface Overview { entities: Entity[]; transactions: TxnRow[]; pairBalances: PairBalance[]; groupTie: GroupTie }

interface AccountHit { id: string; account_number: string; name: string; account_type: string }

const NATURE_META: Record<Nature, { label: string; help: string; badge: string }> = {
  FUNDING: { label: 'Funding / advance', help: 'One entity sends cash to another (a loan or advance).', badge: 'badge-info' },
  EXPENSE_ON_BEHALF: { label: 'Expense paid on behalf', help: 'One entity pays a third-party cost that belongs to another.', badge: 'badge-warning' },
  REPAYMENT: { label: 'Repayment', help: 'The borrowing entity repays the other, relieving the position.', badge: 'badge-success' },
};

const fmt = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const today = () => new Date().toISOString().slice(0, 10);

interface FormState {
  nature: Nature;
  fromLocationId: string;
  toLocationId: string;
  amount: string;
  transactionDate: string;
  memo: string;
  expenseAccountId: string;
  expenseAccountLabel: string;
}
const EMPTY_FORM: FormState = {
  nature: 'FUNDING', fromLocationId: '', toLocationId: '', amount: '',
  transactionDate: today(), memo: '', expenseAccountId: '', expenseAccountLabel: '',
};

/**
 * Intercompany due-to / due-from workspace. Rendered as the "Intercompany" tab of
 * the Consolidation shell (the standalone /intercompany route redirects here).
 * Chrome-free (no page wrapper / PageHeader) so it drops cleanly into a tab body.
 */
export function IntercompanyWorkspace() {
  const { data, isLoading, error, refetch } = useQuery<Overview>('/api/intercompany');
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const entities = data?.entities ?? [];
  const txns = data?.transactions ?? [];
  const pairs = data?.pairBalances ?? [];
  const tie = data?.groupTie;

  const openForm = () => { setFormErr(null); setForm({ ...EMPTY_FORM }); };

  const submit = async () => {
    if (!form) return;
    setFormErr(null);
    const amountCents = Math.round(parseFloat(form.amount) * 100);
    if (!form.fromLocationId || !form.toLocationId) return setFormErr('Choose both entities.');
    if (form.fromLocationId === form.toLocationId) return setFormErr('The two entities must be different.');
    if (!Number.isFinite(amountCents) || amountCents <= 0) return setFormErr('Enter an amount greater than zero.');
    if (form.nature === 'EXPENSE_ON_BEHALF' && !form.expenseAccountId) return setFormErr('Choose the expense account for the receiving entity.');

    setSaving(true);
    const res = await api.post<{ ic_number: string }>('/api/intercompany', {
      nature: form.nature,
      from_location_id: form.fromLocationId,
      to_location_id: form.toLocationId,
      amount_cents: amountCents,
      transaction_date: form.transactionDate,
      memo: form.memo || undefined,
      expense_account_id: form.nature === 'EXPENSE_ON_BEHALF' ? form.expenseAccountId : undefined,
    });
    setSaving(false);
    if (res.error) { setFormErr(res.error.error); return; }
    addToast('success', `Posted ${res.data?.ic_number} — both entities booked`);
    setForm(null);
    refetch();
  };

  const voidTxn = async (t: TxnRow) => {
    const reason = window.prompt(`Void intercompany ${t.icNumber}? Both entries will be reversed. Reason:`);
    if (!reason || reason.trim().length < 3) return;
    setBusyId(t.id);
    const res = await api.delete(`/api/intercompany?id=${t.id}&reason=${encodeURIComponent(reason.trim())}`);
    setBusyId(null);
    if (res.error) { addToast('error', `Void failed: ${res.error.error}`); return; }
    addToast('success', `Voided ${t.icNumber}`);
    refetch();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-slate-400 max-w-3xl">
          Due-to / due-from between entities. Each transaction books a balanced entry on both entities&apos; books
          and eliminates on consolidation.
        </p>
        <button className="btn btn-primary btn-sm shrink-0" onClick={openForm}>
          <Plus size={14} /> New transaction
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="animate-spin" size={20} />
        </div>
      )}

      {error && !isLoading && (
        <div className="card p-4 flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {!isLoading && !error && data && (
        <div className="space-y-6">
          {tie && (totalsExist(tie)) && (
            <div className={clsx('card p-4 flex items-start gap-3', tie.balanced ? 'border-emerald-500/30' : 'border-amber-500/40')}>
              {tie.balanced
                ? <CheckCircle2 size={18} className="text-emerald-400 mt-0.5 shrink-0" />
                : <AlertTriangle size={18} className="text-amber-400 mt-0.5 shrink-0" />}
              <div className="text-sm">
                <p className={clsx('font-medium', tie.balanced ? 'text-emerald-300' : 'text-amber-300')}>
                  {tie.balanced ? 'Intercompany ledger ties' : 'Intercompany imbalance detected'}
                </p>
                <p className="text-slate-400 mt-0.5">
                  Group receivables <span className="font-mono text-slate-200">{fmt(tie.totalReceivableCents)}</span>
                  {' '}vs payables <span className="font-mono text-slate-200">{fmt(tie.totalPayableCents)}</span>
                  {!tie.balanced && <> — off by <span className="font-mono text-amber-300">{fmt(Math.abs(tie.differenceCents))}</span></>}
                  . These net to zero on the consolidated balance sheet.
                </p>
              </div>
            </div>
          )}

          {/* Outstanding positions */}
          <section>
            <h2 className="text-sm font-semibold text-slate-300 mb-2">Outstanding positions</h2>
            {pairs.length === 0 ? (
              <div className="card p-4 text-sm text-slate-500">No open intercompany balances. All settled.</div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {pairs.map((p) => (
                  <div key={p.creditorEntity.id + p.debtorEntity.id} className="card p-3 flex items-center justify-between">
                    <div className="text-sm text-slate-300 flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-white">{p.debtorEntity.name}</span>
                      <span className="text-slate-500">owes</span>
                      <span className="font-medium text-white">{p.creditorEntity.name}</span>
                    </div>
                    <span className="font-mono text-sm text-emerald-300">{fmt(p.netCents)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Transactions */}
          <section>
            <h2 className="text-sm font-semibold text-slate-300 mb-2">Transactions</h2>
            {txns.length === 0 ? (
              <EmptyState
                icon={Combine}
                title="No intercompany transactions yet"
                description="Record a funding advance, an expense paid on behalf of another entity, or a repayment."
                action={{ label: 'New transaction', onClick: openForm }}
              />
            ) : (
              <div className="card overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                    <tr>
                      <th className="text-left font-medium px-4 py-2.5">Date</th>
                      <th className="text-left font-medium px-4 py-2.5">IC #</th>
                      <th className="text-left font-medium px-4 py-2.5">Type</th>
                      <th className="text-left font-medium px-4 py-2.5">From → To</th>
                      <th className="text-right font-medium px-4 py-2.5">Amount</th>
                      <th className="text-left font-medium px-4 py-2.5">Entries</th>
                      <th className="px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {txns.map((t) => (
                      <tr key={t.id} className={clsx('border-b border-slate-800/60 last:border-0', t.status === 'VOIDED' && 'opacity-50')}>
                        <td className="px-4 py-2.5 text-slate-400 font-mono text-xs">{t.transactionDate}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{t.icNumber}</td>
                        <td className="px-4 py-2.5">
                          <span className={clsx('badge', NATURE_META[t.nature].badge)}>{NATURE_META[t.nature].label}</span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-300">
                          <span className="inline-flex items-center gap-1.5">
                            {t.fromEntity?.name ?? '—'} <ArrowRight size={12} className="text-slate-600" /> {t.toEntity?.name ?? '—'}
                          </span>
                          {t.memo && <span className="block text-2xs text-slate-500 mt-0.5">{t.memo}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-200">{fmt(t.amountCents)}</td>
                        <td className="px-4 py-2.5 text-2xs font-mono text-slate-500">
                          {t.fromEntryNumber ?? '—'} / {t.toEntryNumber ?? '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {t.status === 'POSTED' ? (
                            <button
                              className="btn btn-ghost btn-sm text-red-400"
                              onClick={() => voidTxn(t)}
                              disabled={busyId === t.id}
                              title="Void (reverses both entries)"
                            >
                              {busyId === t.id ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
                            </button>
                          ) : (
                            <span className="badge badge-neutral">Voided</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {form && (
        <NewTransactionModal
          form={form}
          setForm={setForm}
          entities={entities}
          saving={saving}
          error={formErr}
          onClose={() => setForm(null)}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

function totalsExist(tie: GroupTie) {
  return tie.totalReceivableCents !== 0 || tie.totalPayableCents !== 0;
}

// ── Create modal ──────────────────────────────────────────────────────────────
function NewTransactionModal(props: {
  form: FormState;
  setForm: (f: FormState) => void;
  entities: Entity[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { form, setForm, entities, saving, error, onClose, onSubmit } = props;
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-white">New intercompany transaction</h3>
          <button className="text-slate-500 hover:text-slate-300" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-slate-400">Type</label>
            <select className="input mt-1" value={form.nature} onChange={(e) => set({ nature: e.target.value as Nature })}>
              {(Object.keys(NATURE_META) as Nature[]).map((n) => (
                <option key={n} value={n}>{NATURE_META[n].label}</option>
              ))}
            </select>
            <p className="text-2xs text-slate-500 mt-1">{NATURE_META[form.nature].help}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400">{form.nature === 'REPAYMENT' ? 'Creditor (being repaid)' : 'From entity (pays)'}</label>
              <select className="input mt-1" value={form.fromLocationId} onChange={(e) => set({ fromLocationId: e.target.value })}>
                <option value="">Select…</option>
                {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400">{form.nature === 'REPAYMENT' ? 'Debtor (repaying)' : 'To entity (receives)'}</label>
              <select className="input mt-1" value={form.toLocationId} onChange={(e) => set({ toLocationId: e.target.value })}>
                <option value="">Select…</option>
                {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400">Amount (USD)</label>
              <input className="input mt-1 font-mono" inputMode="decimal" placeholder="0.00"
                value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-slate-400">Date</label>
              <input type="date" className="input mt-1" value={form.transactionDate} onChange={(e) => set({ transactionDate: e.target.value })} />
            </div>
          </div>

          {form.nature === 'EXPENSE_ON_BEHALF' && (
            <ExpenseAccountPicker
              valueLabel={form.expenseAccountLabel}
              onPick={(a) => set({ expenseAccountId: a.id, expenseAccountLabel: `${a.account_number} · ${a.name}` })}
            />
          )}

          <div>
            <label className="text-xs text-slate-400">Memo (optional)</label>
            <input className="input mt-1" value={form.memo} onChange={(e) => set({ memo: e.target.value })} placeholder="e.g. Cover Q2 insurance premium" />
          </div>

          {error && <div className="text-sm text-red-400 flex items-center gap-2"><AlertCircle size={14} /> {error}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={onSubmit} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Post transaction
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Expense account search (COGS / OPEX only) ───────────────────────────────────
function ExpenseAccountPicker({ valueLabel, onPick }: { valueLabel: string; onPick: (a: AccountHit) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<AccountHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (term: string) => {
    setLoading(true);
    const res = await api.get<{ accounts?: AccountHit[] } | AccountHit[]>('/api/accounts/search', { q: term });
    setLoading(false);
    const raw = Array.isArray(res.data) ? res.data : res.data?.accounts ?? [];
    setHits(raw.filter((a) => ['COGS', 'OPEX', 'OTHER'].includes(a.account_type)));
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => search(q), 250);
    return () => clearTimeout(id);
  }, [q, open, search]);

  return (
    <div>
      <label className="text-xs text-slate-400">Expense account (booked on the receiving entity)</label>
      <div className="relative mt-1">
        <Search size={14} className="absolute left-2.5 top-2.5 text-slate-500" />
        <input
          className="input pl-8"
          placeholder={valueLabel || 'Search COGS / operating-expense accounts…'}
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        />
        {open && (
          <div className="absolute z-10 mt-1 w-full card max-h-56 overflow-auto p-1">
            {loading && <div className="px-3 py-2 text-xs text-slate-500 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Searching…</div>}
            {!loading && hits.length === 0 && <div className="px-3 py-2 text-xs text-slate-500">No matching expense accounts.</div>}
            {hits.map((a) => (
              <button key={a.id} type="button"
                className="w-full text-left px-3 py-1.5 rounded hover:bg-slate-800 text-sm text-slate-300 flex items-center gap-2"
                onClick={() => { onPick(a); setOpen(false); setQ(''); }}>
                <span className="font-mono text-xs text-slate-500">{a.account_number}</span> {a.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {valueLabel && <p className="text-2xs text-emerald-400 mt-1">Selected: {valueLabel}</p>}
    </div>
  );
}
