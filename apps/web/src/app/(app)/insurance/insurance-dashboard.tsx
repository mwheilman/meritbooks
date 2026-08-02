'use client';

import { useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  Loader2, AlertCircle, ShieldCheck, Plus, Sparkles, Pencil, Trash2, CalendarClock,
  AlertTriangle, ExternalLink,
} from 'lucide-react';
import { InsuranceParseReview } from './insurance-parse-review';
import { InsuranceEditor, type EditorPolicy } from './insurance-editor';

type CoverageType = EditorPolicy['coverage_type'];
type Frequency = EditorPolicy['premium_frequency'];
type Status = EditorPolicy['status'];

interface Policy {
  id: string;
  carrier: string | null;
  policy_number: string | null;
  coverage_type: CoverageType;
  coverage_limit_cents: number | null;
  deductible_cents: number | null;
  premium_cents: number | null;
  premium_frequency: Frequency;
  effective_date: string | null;
  expiration_date: string | null;
  status: Status;
  broker: string | null;
  notes: string | null;
}

interface RenewalDue {
  policy: Policy;
  daysUntil: number;
  overdue: boolean;
}

interface InsuranceResponse {
  data: Policy[];
  renewals: RenewalDue[];
  summary: {
    total: number;
    active: number;
    renewalsDue: number;
    overdue: number;
    windowDays: number;
    asOf: string;
    totalAnnualPremiumCents: number;
  };
}

const COVERAGE_LABEL: Record<CoverageType, string> = {
  GL: 'General liability',
  PROPERTY: 'Property',
  AUTO: 'Auto',
  WC: 'Workers comp',
  CYBER: 'Cyber',
  UMBRELLA: 'Umbrella',
  PROFESSIONAL: 'Professional',
  OTHER: 'Other',
};

const FREQ_LABEL: Record<Frequency, string> = {
  ANNUAL: '/yr',
  SEMIANNUAL: '/6mo',
  QUARTERLY: '/qtr',
  MONTHLY: '/mo',
  ONE_TIME: ' one-time',
};

const STATUS_STYLE: Record<Status, string> = {
  ACTIVE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  PENDING: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  EXPIRED: 'bg-slate-700/40 text-slate-400 border-slate-700',
  CANCELLED: 'bg-red-500/10 text-red-400 border-red-500/20',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function fmtCents(cents: number | null): string {
  return cents === null ? '—' : formatMoney(cents);
}
function renewalTone(daysUntil: number): string {
  if (daysUntil <= 0) return 'text-red-400';
  if (daysUntil <= 30) return 'text-amber-400';
  return 'text-slate-300';
}

export function InsuranceDashboard() {
  const [editing, setEditing] = useState<EditorPolicy | null | 'new'>(null);
  const [parsing, setParsing] = useState(false);
  const [refreshKey, setRefreshKey] = useState('0');

  const { data, isLoading, error, refetch } = useQuery<InsuranceResponse>('/api/insurance', undefined, { key: refreshKey });

  const policies = data?.data ?? [];
  const renewals = data?.renewals ?? [];
  const summary = data?.summary;

  function bump() {
    setRefreshKey((k) => String(Number(k) + 1));
    refetch();
  }

  async function remove(p: Policy) {
    if (!confirm(`Delete the ${COVERAGE_LABEL[p.coverage_type]} policy${p.carrier ? ` with ${p.carrier}` : ''}?`)) return;
    const res = await api.delete(`/api/insurance/${p.id}`);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast('success', 'Policy deleted');
    bump();
  }

  function toEditor(p: Policy): EditorPolicy {
    return { ...p };
  }

  const Controls = (
    <div className="flex items-center gap-2">
      <button onClick={() => setParsing(true)} className="px-3 py-1.5 text-xs font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg flex items-center gap-1.5">
        <Sparkles size={13} /> Upload policy
      </button>
      <button onClick={() => setEditing('new')} className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1.5">
        <Plus size={13} /> Add policy
      </button>
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-10 text-center">
        <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Summary strip */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 text-xs">
          {summary && (
            <>
              <span className="text-slate-500">{summary.total} polic{summary.total === 1 ? 'y' : 'ies'}</span>
              <span className="text-emerald-400">{summary.active} active</span>
              {summary.renewalsDue > 0 && <span className="text-amber-400 font-medium">{summary.renewalsDue} renewing ≤{summary.windowDays}d</span>}
              {summary.overdue > 0 && <span className="text-red-400 font-medium">{summary.overdue} lapsed</span>}
              <span className="text-slate-500">Annualized premium <span className="font-mono text-slate-300">{formatMoney(summary.totalAnnualPremiumCents)}</span></span>
            </>
          )}
        </div>
        {Controls}
      </div>

      {/* Renewals-due section */}
      {renewals.length > 0 && (
        <div className="card p-4 border border-amber-500/20">
          <div className="flex items-center gap-2 mb-3">
            <CalendarClock size={15} className="text-amber-400" />
            <h3 className="text-sm font-semibold text-white">Renewals due</h3>
            <span className="text-[11px] text-slate-500">next {summary?.windowDays ?? 60} days</span>
          </div>
          <div className="space-y-1.5">
            {renewals.map((r) => (
              <div key={r.policy.id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-950/40 px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  {r.overdue && <AlertTriangle size={13} className="text-red-400 shrink-0" />}
                  <span className="text-xs text-white truncate">{r.policy.carrier ?? 'Unnamed carrier'}</span>
                  <span className="text-[11px] text-slate-500">{COVERAGE_LABEL[r.policy.coverage_type]}</span>
                  {r.policy.policy_number && <span className="text-[11px] text-slate-600 font-mono truncate">{r.policy.policy_number}</span>}
                </div>
                <div className={clsx('text-[11px] font-medium shrink-0', renewalTone(r.daysUntil))}>
                  {r.overdue
                    ? `Lapsed ${Math.abs(r.daysUntil)}d ago · ${fmtDate(r.policy.expiration_date)}`
                    : `${r.daysUntil}d · ${fmtDate(r.policy.expiration_date)}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Register */}
      {policies.length === 0 ? (
        <div className="card p-12 text-center">
          <ShieldCheck className="w-10 h-10 mx-auto text-slate-600 mb-3" />
          <p className="text-sm text-slate-300 mb-1">No policies in the register</p>
          <p className="text-xs text-slate-500 max-w-md mx-auto mb-4">
            Drop in your insurance policy or declarations page and AI extracts the carrier, coverage type,
            limits, deductible, and premium — for you to review and confirm. MeritBooks then tracks coverage
            and flags renewals before they lapse.
          </p>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => setParsing(true)} className="px-4 py-2 text-sm font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg inline-flex items-center gap-1.5">
              <Sparkles size={14} /> Upload policy
            </button>
            <button onClick={() => setEditing('new')} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1.5">
              <Plus size={14} /> Add manually
            </button>
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2.5 font-medium">Carrier / policy</th>
                  <th className="px-4 py-2.5 font-medium">Coverage</th>
                  <th className="px-4 py-2.5 font-medium text-right">Limit</th>
                  <th className="px-4 py-2.5 font-medium text-right">Deductible</th>
                  <th className="px-4 py-2.5 font-medium text-right">Premium</th>
                  <th className="px-4 py-2.5 font-medium">Expiration</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={p.id} className="border-b border-slate-800/60 hover:bg-slate-900/40">
                    <td className="px-4 py-2.5">
                      <div className="text-sm text-white">{p.carrier ?? '—'}</div>
                      <div className="text-[11px] text-slate-500 font-mono">{p.policy_number ?? '—'}{p.broker ? ` · ${p.broker}` : ''}</div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-300">{COVERAGE_LABEL[p.coverage_type]}</td>
                    <td className="px-4 py-2.5 text-right text-sm font-mono text-slate-200">{fmtCents(p.coverage_limit_cents)}</td>
                    <td className="px-4 py-2.5 text-right text-xs font-mono text-slate-400">{fmtCents(p.deductible_cents)}</td>
                    <td className="px-4 py-2.5 text-right text-sm font-mono text-slate-200">
                      {p.premium_cents === null ? '—' : <>{formatMoney(p.premium_cents)}<span className="text-slate-500">{FREQ_LABEL[p.premium_frequency]}</span></>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-300">{fmtDate(p.expiration_date)}</td>
                    <td className="px-4 py-2.5">
                      <span className={clsx('inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium', STATUS_STYLE[p.status])}>
                        {p.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {p.status === 'ACTIVE' && p.premium_frequency === 'ANNUAL' && p.premium_cents !== null && (
                          <Link href="/prepaids" title="Amortize this annual premium as a prepaid" className="px-2 py-1 text-[11px] text-indigo-300 hover:text-indigo-200 rounded-md hover:bg-slate-800 flex items-center gap-1">
                            <ExternalLink size={11} /> Amortize
                          </Link>
                        )}
                        <button onClick={() => setEditing(toEditor(p))} className="px-2 py-1 text-[11px] text-slate-400 hover:text-white rounded-md hover:bg-slate-800 flex items-center gap-1">
                          <Pencil size={11} /> Edit
                        </button>
                        <button onClick={() => remove(p)} className="px-2 py-1 text-[11px] text-slate-500 hover:text-red-400 rounded-md hover:bg-slate-800 flex items-center gap-1">
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-600 leading-relaxed">
        This register tracks the company&rsquo;s OWN insurance — distinct from vendor certificates of insurance
        (Vendor Compliance). AI proposes the extracted terms from an uploaded policy; every policy is confirmed
        by a human before it enters the register. Renewals are computed from each policy&rsquo;s expiration date.
      </p>

      {parsing && (
        <InsuranceParseReview
          onClose={() => setParsing(false)}
          onConfirmed={() => { setParsing(false); bump(); }}
        />
      )}

      {editing && (
        <InsuranceEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); bump(); }}
        />
      )}
    </div>
  );
}
