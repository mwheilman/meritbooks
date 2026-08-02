'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  X, Loader2, Check, ShieldAlert, Briefcase, UserCheck, CalendarClock,
  DollarSign, Ban, AlertCircle,
} from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { AttachmentsPanel } from '@/components/documents/attachments-panel';

interface DetailLine {
  id: string;
  line_number: number;
  description: string | null;
  quantity: number;
  unit_cost_cents: number;
  amount_cents: number;
  job_id: string | null;
  account: { id: string; account_number: string; name: string; account_type: string } | null;
  job: { id: string; job_number: string; name: string } | null;
}

interface Attribution {
  id: string;
  job_id: string;
  cost_type: string;
  amount_cents: number;
  lifecycle: string;
  gate: string;
}

interface BillDetailData {
  bill: {
    id: string;
    bill_number: string | null;
    bill_date: string;
    due_date: string;
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
    amount_paid_cents: number;
    balance_cents: number;
    status: string;
    payment_hold_reason: string | null;
    scheduled_payment_date: string | null;
    payment_method: string | null;
    void_reason: string | null;
    location: { id: string; name: string; short_code: string } | null;
    vendor: { id: string; name: string; display_name: string | null } | null;
  };
  lines: DetailLine[];
  attributions: Attribution[];
  approver: { type: string | null; ref: string | null; name: string | null };
  policy: {
    active: { name: string; version: number } | null;
    requiredApprovalTier: string | null;
    blocked: boolean;
    violations: { rule_id: string; severity: 'WARN' | 'BLOCK'; message: string }[];
  } | null;
}

const APPROVER_LABEL: Record<string, string> = {
  ACCOUNTING: 'Accounting',
  RESPONSIBLE_PARTY: 'Responsible party',
  PM_LEADER: 'PM / Leader',
};

interface Employee { id: string; fullName: string }

export function BillDetail({ billId, onClose, onChanged }: { billId: string; onClose: () => void; onChanged: () => void }) {
  const { data, isLoading, error, refetch } = useQuery<BillDetailData>(`/api/bills/${billId}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [showVoid, setShowVoid] = useState(false);
  const [overrideType, setOverrideType] = useState('');
  const [overrideRef, setOverrideRef] = useState('');
  const [holdReason, setHoldReason] = useState('');
  const [showRelease, setShowRelease] = useState(false);

  const { data: teamData } = useQuery<{ data: Employee[] }>(
    overrideType === 'RESPONSIBLE_PARTY' || overrideType === 'PM_LEADER' ? '/api/team' : null
  );
  const employees = teamData?.data ?? [];

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const post = useCallback(async (payload: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      const res = await fetch(`/api/bills/${billId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) {
        addToast('error', result.error ?? 'Action failed');
        return false;
      }
      addToast('success', `${label} done`);
      await refetch();
      onChanged();
      return true;
    } catch {
      addToast('error', 'Network error');
      return false;
    } finally {
      setBusy(null);
    }
  }, [billId, refetch, onChanged]);

  const bill = data?.bill;
  const balance = bill ? bill.total_cents - bill.amount_paid_cents : 0;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-[540px] max-w-full bg-surface-900 border-l border-slate-800 z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white">Bill detail</h2>
            {bill && <StatusBadge status={bill.status} />}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]"><X size={18} /></button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
        ) : error || !bill ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <AlertCircle className="w-8 h-8 text-red-400" />
            <p className="text-sm text-red-400">{error ?? 'Bill not found'}</p>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              {/* Summary */}
              <div className="rounded-lg bg-slate-800/40 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-200 font-medium">{bill.vendor?.display_name ?? bill.vendor?.name ?? 'Vendor'}</span>
                  <span className="text-sm font-mono text-slate-400">{bill.bill_number ?? '--'}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>{bill.location?.short_code ?? '--'} · billed {bill.bill_date}</span>
                  <span>due {bill.due_date}</span>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-2xs text-slate-500 uppercase tracking-wider">Total</span>
                  <span className="text-lg font-mono font-semibold text-white">{formatMoney(bill.total_cents)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">Paid {formatMoney(bill.amount_paid_cents)}</span>
                  <span className={clsx('font-mono', balance > 0 ? 'text-amber-400' : 'text-emerald-400')}>Balance {formatMoney(balance)}</span>
                </div>
              </div>

              {bill.status === 'ON_HOLD' && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <ShieldAlert size={14} className="text-red-400 mt-0.5" />
                    <p className="text-xs text-red-400">{bill.payment_hold_reason ?? 'On hold for vendor compliance. Resolve the vendor docs, or release this bill with an override.'}</p>
                  </div>
                  {!showRelease ? (
                    <button onClick={() => setShowRelease(true)} className="text-2xs font-medium text-red-300 hover:text-red-200 underline">
                      Release hold (override)
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input value={holdReason} onChange={(e) => setHoldReason(e.target.value)} placeholder="Reason for the override…"
                        className="flex-1 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs text-white" />
                      <button disabled={!holdReason || busy !== null}
                        onClick={() => post({ action: 'release_hold', reason: holdReason }, 'Release hold')}
                        className="px-2.5 py-1.5 rounded-md text-xs bg-red-600 text-white hover:bg-red-500 disabled:opacity-40">Release</button>
                      <button onClick={() => { setShowRelease(false); setHoldReason(''); }} className="text-2xs text-slate-400 hover:text-slate-200">Cancel</button>
                    </div>
                  )}
                  <p className="text-[10px] text-slate-500">One-time release for this bill. Audit-logged.</p>
                </div>
              )}
              {bill.status === 'VOIDED' && bill.void_reason && (
                <div className="px-3 py-2 rounded-lg bg-slate-800/60 text-xs text-slate-400">Voided: {bill.void_reason}</div>
              )}

              {/* AP policy evaluation — deterministic engine vs the ACTIVE ruleset */}
              {data?.policy?.active && (data.policy.violations.length > 0 || data.policy.requiredApprovalTier) && (
                <div className={clsx(
                  'rounded-lg border p-3 space-y-2',
                  data.policy.blocked ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/25 bg-amber-500/[0.05]'
                )}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ShieldAlert size={14} className={data.policy.blocked ? 'text-red-400' : 'text-amber-400'} />
                      <span className="text-xs font-semibold text-slate-200">
                        AP policy: {data.policy.active.name} v{data.policy.active.version}
                      </span>
                    </div>
                    {data.policy.requiredApprovalTier && (
                      <span className="text-2xs font-mono text-slate-300 bg-slate-800/70 rounded px-2 py-0.5">
                        Requires {data.policy.requiredApprovalTier}
                      </span>
                    )}
                  </div>
                  {data.policy.violations.length === 0 ? (
                    <p className="text-[11px] text-emerald-300">No policy violations.</p>
                  ) : (
                    <ul className="space-y-1">
                      {data.policy.violations.map((v, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px]">
                          <span className={clsx(
                            'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold',
                            v.severity === 'BLOCK' ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300'
                          )}>{v.severity}</span>
                          <span className="text-slate-300">{v.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {data.policy.blocked && (
                    <p className="text-[10px] text-red-300/80">
                      This bill is BLOCKED by policy. Approval requires an audited override reason.
                    </p>
                  )}
                </div>
              )}

              {/* Approver routing */}
              <div>
                <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Routed approver</label>
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700">
                  <UserCheck size={14} className="text-slate-500" />
                  <span className="text-sm text-slate-200">
                    {bill.status === 'PENDING' || bill.status === 'ON_HOLD'
                      ? (data?.approver.type ? APPROVER_LABEL[data.approver.type] : 'Accounting')
                      : APPROVER_LABEL[data?.approver.type ?? ''] ?? 'Accounting'}
                    {data?.approver.name && <span className="text-slate-500 ml-1">· {data.approver.name}</span>}
                  </span>
                </div>
                {(bill.status === 'PENDING' || bill.status === 'ON_HOLD') && (
                  <div className="flex items-center gap-2 mt-2">
                    <select value={overrideType} onChange={(e) => { setOverrideType(e.target.value); setOverrideRef(''); }}
                      className="flex-1 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs text-white">
                      <option value="">Re-route to…</option>
                      <option value="ACCOUNTING">Accounting</option>
                      <option value="RESPONSIBLE_PARTY">Responsible party</option>
                      <option value="PM_LEADER">PM / Leader</option>
                    </select>
                    {(overrideType === 'RESPONSIBLE_PARTY' || overrideType === 'PM_LEADER') && (
                      <select value={overrideRef} onChange={(e) => setOverrideRef(e.target.value)}
                        className="flex-1 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs text-white">
                        <option value="">Person…</option>
                        {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
                      </select>
                    )}
                    <button
                      onClick={() => post({ action: 'override_approver', approver_type: overrideType, approver_ref: overrideRef || null }, 'Re-route')}
                      disabled={!overrideType || busy !== null}
                      className="px-2.5 py-1.5 rounded-md text-xs bg-slate-700 text-slate-200 hover:bg-slate-600 disabled:opacity-40"
                    >
                      Set
                    </button>
                  </div>
                )}
              </div>

              {/* Lines */}
              <div>
                <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Lines</label>
                <div className="border border-slate-800 rounded-lg overflow-hidden">
                  <table className="w-full">
                    <tbody className="divide-y divide-slate-800/30">
                      {data?.lines.map((l) => (
                        <tr key={l.id}>
                          <td className="px-3 py-2">
                            <p className="text-sm text-slate-200">{l.description || l.account?.name || '--'}</p>
                            <p className="text-2xs text-slate-500 font-mono">
                              {l.account ? `${l.account.account_number} · ${l.account.name}` : ''}
                            </p>
                            {l.job && (
                              <span className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-2xs bg-brand-500/10 text-brand-400">
                                <Briefcase size={9} /> {l.job.job_number} · {l.job.name}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-sm font-mono text-slate-200 whitespace-nowrap">{formatMoney(l.amount_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data && data.attributions.length > 0 && (
                  <p className="text-2xs text-slate-500 mt-2">
                    {data.attributions.filter((a) => a.lifecycle === 'CLEARED').length} of {data.attributions.length} job cost(s) cleared to Projects
                  </p>
                )}
              </div>

              {/* Retained source documents for this bill */}
              <AttachmentsPanel entityType="bill" entityId={bill.id} defaultDocType="BILL" title="Documents" />
            </div>

            {/* Footer actions */}
            <div className="px-6 py-4 border-t border-slate-800 space-y-3">
              {showVoid ? (
                <div className="space-y-2">
                  <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Reason for voiding…"
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm text-white" />
                  <div className="flex gap-2">
                    <button onClick={() => setShowVoid(false)} className="flex-1 px-3 py-2 rounded-md text-sm text-slate-400 hover:bg-slate-800">Cancel</button>
                    <button disabled={!voidReason || busy !== null}
                      onClick={async () => { if (await post({ action: 'void', reason: voidReason }, 'Void')) onClose(); }}
                      className="flex-1 px-3 py-2 rounded-md text-sm bg-red-600 text-white hover:bg-red-500 disabled:opacity-40">Confirm void</button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {bill.status === 'PENDING' && (
                    <button disabled={busy !== null}
                      onClick={() => post({ action: 'approve' }, 'Approve')}
                      className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">
                      {busy === 'Approve' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve &amp; post
                    </button>
                  )}

                  {(bill.status === 'APPROVED' || bill.status === 'SCHEDULED') && (
                    <div className="flex items-center gap-2 flex-1">
                      <input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)}
                        className="flex-1 px-2 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm text-white font-mono" />
                      <button disabled={!scheduleDate || busy !== null}
                        onClick={() => post({ action: 'schedule', scheduled_payment_date: scheduleDate }, 'Schedule')}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40">
                        <CalendarClock size={14} /> {bill.status === 'SCHEDULED' ? 'Reschedule' : 'Schedule'}
                      </button>
                    </div>
                  )}

                  {['APPROVED', 'SCHEDULED', 'PARTIALLY_PAID'].includes(bill.status) && (
                    <div className="flex items-center gap-2 flex-1">
                      <div className="relative flex-1">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-500">$</span>
                        <input type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder={(balance / 100).toFixed(2)}
                          className="w-full pl-6 pr-2 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm text-white font-mono" />
                      </div>
                      <button disabled={busy !== null}
                        onClick={() => post({ action: 'pay', amount_cents: Math.round(parseFloat(payAmount || String(balance / 100)) * 100) }, 'Payment')}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40">
                        <DollarSign size={14} /> Record payment
                      </button>
                    </div>
                  )}

                  {bill.status !== 'VOIDED' && bill.status !== 'PAID' && bill.amount_paid_cents === 0 && (
                    <button onClick={() => setShowVoid(true)} disabled={busy !== null}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm text-slate-400 hover:text-red-400 hover:bg-red-500/10">
                      <Ban size={14} /> Void
                    </button>
                  )}

                  {(bill.status === 'PAID' || bill.status === 'VOIDED') && (
                    <p className="text-xs text-slate-500 w-full text-center">No further actions for {bill.status.toLowerCase()} bills.</p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
