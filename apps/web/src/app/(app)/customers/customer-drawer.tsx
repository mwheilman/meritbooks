'use client';
import { useState } from 'react';
import { FileText, Download, Send, Loader2, AlertTriangle, ShieldCheck, GitMerge, Sparkles } from 'lucide-react';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { EntityInvoiceSettings } from '@/components/entity-invoice-settings';
import { InvoiceTextOverrides } from '@/components/invoice-text-overrides';

type StatementMode = 'open' | 'activity';

/**
 * AR statement controls (FPB-invoices §7): pick open-item vs activity + an
 * as-of date, then preview/download the branded PDF or email it to the customer.
 * The GET route streams the PDF (opened in a new tab); the send route emails it
 * via the same transport as invoices and degrades gracefully when email isn't
 * configured — the toast surfaces the real reason, never a generic failure.
 */
function StatementActions({ customerId, hasEmail }: { customerId: string; hasEmail: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [mode, setMode] = useState<StatementMode>('open');
  const [asOf, setAsOf] = useState(today);
  const [sending, setSending] = useState(false);

  const query = () => {
    const p = new URLSearchParams({ mode });
    if (asOf && asOf !== today) p.set('as_of', asOf);
    return p.toString();
  };

  const preview = (download: boolean) => {
    const p = new URLSearchParams(query());
    if (download) p.set('download', '1');
    window.open(`/api/customers/${customerId}/statement?${p.toString()}`, '_blank', 'noopener');
  };

  const send = async () => {
    if (!hasEmail) {
      addToast('error', 'This customer has no email address on file.');
      return;
    }
    setSending(true);
    try {
      const res = await fetch(`/api/customers/${customerId}/statement/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, as_of: asOf }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.sent) {
        addToast('success', `Statement emailed to ${body.to}`);
      } else {
        // Distinct reasons: not configured, no email, provider rejected.
        addToast('error', body.error ?? 'Could not send the statement.');
      }
    } catch {
      addToast('error', 'Could not reach the send service. Try again.');
    } finally {
      setSending(false);
    }
  };

  const toggle = 'px-2.5 py-1 rounded-md text-xs font-medium transition-colors';
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={() => setMode('open')} className={`${toggle} ${mode === 'open' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>Open items</button>
        <button onClick={() => setMode('activity')} className={`${toggle} ${mode === 'activity' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>Activity</button>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-2xs text-slate-500 uppercase tracking-wider">As of</span>
          <input type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value || today)}
            className="px-2 py-1 rounded-md bg-slate-900 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => preview(false)} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">
          <FileText size={12} /> Preview
        </button>
        <button onClick={() => preview(true)} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">
          <Download size={12} /> Download
        </button>
        <button onClick={send} disabled={sending || !hasEmail}
          title={hasEmail ? 'Email this statement to the customer' : 'No customer email on file'}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed">
          {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          {sending ? 'Sending…' : 'Send statement'}
        </button>
      </div>
      {!hasEmail && (
        <p className="text-2xs text-slate-500">Add an email address to enable sending. Preview and download always work.</p>
      )}
    </div>
  );
}

interface CustDetail {
  id: string; name: string; legalName: string; email: string | null; phone: string | null;
  contactName: string | null; addressLine: string | null; website: string | null;
  paymentTermsDays: number | null; creditLimitCents: number | null; taxExempt: boolean;
  isPortfolioCompany: boolean; isActive: boolean; notes: string | null;
  ar: { totalOutstanding: number; overdueCount: number; openInvoiceCount: number };
  recentInvoices: Array<{ id: string; invoiceNumber: string; invoiceDate: string; totalCents: number; balanceCents: number; status: string }>;
}

type RiskFlag = 'SLOW_PAY' | 'OVER_LIMIT' | 'APPROACHING_LIMIT' | 'DELINQUENT' | 'CONCENTRATION';
type RiskLevel = 'low' | 'medium' | 'high';

interface Dossier {
  id: string; name: string;
  creditLimitCents: number | null; termsDays: number;
  behavior: {
    paidApplicationCount: number; avgDaysToPay: number | null; medianDaysToPay: number | null;
    worstDaysToPay: number | null; lastDaysToPay: number | null; lastPaymentDate: string | null;
    onTimeRate: number | null; avgDaysBeyondTerms: number | null; ttmRevenueCents: number;
    openBalanceCents: number; overdueBalanceCents: number; overdueInvoiceCount: number; maxOverdueDays: number;
  };
  credit: { creditLimitCents: number | null; openArCents: number; utilizationPct: number | null; availableCreditCents: number | null };
  risk: { flags: RiskFlag[]; level: RiskLevel; summary: string; aiSummary: string };
  concentrationPct: number | null;
  possibleDuplicates: Array<{ id: string; name: string; confidence: number; matchedFields: string[]; reason: string; amountAtRiskCents: number }>;
}

const RISK_STYLE: Record<RiskLevel, { badge: string; label: string }> = {
  low: { badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', label: 'Low risk' },
  medium: { badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30', label: 'Medium risk' },
  high: { badge: 'bg-red-500/15 text-red-300 border-red-500/30', label: 'High risk' },
};

const FLAG_LABEL: Record<RiskFlag, string> = {
  SLOW_PAY: 'Slow pay', OVER_LIMIT: 'Over credit limit', APPROACHING_LIMIT: 'Near credit limit',
  DELINQUENT: 'Delinquent', CONCENTRATION: 'Revenue concentration',
};

function pct(n: number | null): string {
  return n == null ? '--' : `${Math.round(n * 100)}%`;
}

/** A single "possible duplicate" row with a guarded merge action (this customer = survivor). */
function DuplicateRow({
  survivorId, survivorName, dup, onMerged,
}: {
  survivorId: string; survivorName: string;
  dup: Dossier['possibleDuplicates'][number]; onMerged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const merge = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/customers/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ survivor_id: survivorId, duplicate_id: dup.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.merged) {
        addToast('success', `Merged "${dup.name}" into "${survivorName}".`);
        onMerged();
      } else if (body.code === 'RECONCILE_FAILED') {
        addToast('error', 'Merge did not reconcile — nothing was changed. Review the two records.');
      } else if (res.status === 403) {
        addToast('error', 'You do not have permission to merge customers.');
      } else {
        addToast('error', body.error ?? 'Could not merge these customers.');
      }
    } catch {
      addToast('error', 'Could not reach the merge service. Try again.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-200 truncate">{dup.name}</span>
            <span className="text-2xs font-mono text-amber-300 shrink-0">{Math.round(dup.confidence * 100)}% match</span>
          </div>
          <p className="mt-0.5 text-2xs text-slate-500 line-clamp-2">{dup.reason}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {dup.matchedFields.map((f) => (
              <span key={f} className="px-1.5 py-0.5 rounded bg-slate-800 text-2xs text-slate-400">{f.replace('_', ' ')}</span>
            ))}
            {dup.amountAtRiskCents > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-2xs font-mono text-slate-400">{formatMoney(dup.amountAtRiskCents)} AR</span>
            )}
          </div>
        </div>
        <div className="shrink-0">
          {confirming ? (
            <div className="flex items-center gap-1.5">
              <button onClick={merge} disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50">
                {busy ? <Loader2 size={11} className="animate-spin" /> : <GitMerge size={11} />} Confirm
              </button>
              <button onClick={() => setConfirming(false)} disabled={busy}
                className="px-2 py-1 rounded-md text-2xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirming(true)}
              title={`Merge "${dup.name}" into "${survivorName}"`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">
              <GitMerge size={11} /> Merge in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The deterministic dossier: payment behavior, credit utilization, risk badge, duplicates. */
function CustomerDossierSections({ customerId, survivorName }: { customerId: string; survivorName: string }) {
  const { data, isLoading, error, refetch } = useQuery<Dossier>(`/api/customers/${customerId}/dossier`, undefined, { enabled: !!customerId });

  if (isLoading) {
    return <DetailSection title="Customer dossier"><div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={13} className="animate-spin" /> Computing payment behavior…</div></DetailSection>;
  }
  if (error || !data) {
    return <DetailSection title="Customer dossier"><p className="text-xs text-slate-500">Dossier unavailable.</p></DetailSection>;
  }

  const { behavior: b, credit, risk } = data;
  const rs = RISK_STYLE[risk.level];
  const util = credit.utilizationPct;
  const utilBar = util == null ? 0 : Math.min(100, Math.round(util * 100));
  const utilColor = util != null && util >= 1 ? 'bg-red-500' : util != null && util >= 0.9 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <>
      <DetailSection title="Risk profile">
        <div className="flex items-center gap-2 mb-2">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-2xs font-medium ${rs.badge}`}>
            {risk.level === 'low' ? <ShieldCheck size={11} /> : <AlertTriangle size={11} />} {rs.label}
          </span>
          {risk.flags.map((f) => (
            <span key={f} className="px-1.5 py-0.5 rounded bg-slate-800 text-2xs text-slate-300">{FLAG_LABEL[f]}</span>
          ))}
        </div>
        <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] p-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <Sparkles size={11} className="text-indigo-300" />
            <span className="text-2xs uppercase tracking-wider text-indigo-300 font-semibold">Analyst summary</span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">{risk.aiSummary || risk.summary}</p>
        </div>
      </DetailSection>

      <DetailSection title="Payment behavior">
        <DetailField label="Avg days to pay" value={b.avgDaysToPay != null ? `${b.avgDaysToPay} days` : 'No history'} />
        <DetailField label="Median / worst" value={b.medianDaysToPay != null ? `${b.medianDaysToPay} / ${b.worstDaysToPay} days` : '--'} />
        <DetailField label="On-time rate" value={pct(b.onTimeRate)} />
        <DetailField label="Avg days beyond terms" value={b.avgDaysBeyondTerms != null ? `${b.avgDaysBeyondTerms} days` : '--'} />
        <DetailField label="Last payment" value={b.lastPaymentDate ? `${b.lastPaymentDate}${b.lastDaysToPay != null ? ` (${b.lastDaysToPay}d)` : ''}` : '--'} />
        <DetailField label="TTM revenue" value={formatMoney(b.ttmRevenueCents)} mono />
        {data.concentrationPct != null && <DetailField label="Share of total revenue" value={pct(data.concentrationPct)} />}
        <DetailField label="Overdue" value={b.overdueBalanceCents > 0 ? `${formatMoney(b.overdueBalanceCents)} · ${b.overdueInvoiceCount} inv · ${b.maxOverdueDays}d oldest` : 'None'} mono />
      </DetailSection>

      <DetailSection title="Credit">
        <DetailField label="Credit limit" value={credit.creditLimitCents != null ? formatMoney(credit.creditLimitCents) : 'Not set'} mono />
        <DetailField label="Open AR" value={formatMoney(credit.openArCents)} mono />
        <DetailField label="Available" value={credit.availableCreditCents != null ? formatMoney(credit.availableCreditCents) : '--'} mono />
        {util != null && (
          <div className="mt-1.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-2xs text-slate-500 uppercase tracking-wider">Utilization</span>
              <span className={`text-2xs font-mono ${util >= 1 ? 'text-red-300' : util >= 0.9 ? 'text-amber-300' : 'text-slate-300'}`}>{pct(util)}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
              <div className={`h-full rounded-full ${utilColor}`} style={{ width: `${utilBar}%` }} />
            </div>
          </div>
        )}
        {credit.creditLimitCents == null && (
          <p className="mt-1 text-2xs text-slate-500">No credit limit configured — set one under Edit to enable utilization + over-limit alerts.</p>
        )}
      </DetailSection>

      <DetailSection title={`Possible duplicates${data.possibleDuplicates.length ? ` (${data.possibleDuplicates.length})` : ''}`}>
        {data.possibleDuplicates.length === 0 ? (
          <p className="text-xs text-slate-500">No likely duplicate customers detected.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-2xs text-slate-500">Merging re-points the other record&apos;s invoices &amp; payments onto this customer, then retires it. Reconciled and reversible-safe; requires the customers permission.</p>
            {data.possibleDuplicates.map((d) => (
              <DuplicateRow key={d.id} survivorId={customerId} survivorName={survivorName} dup={d} onMerged={refetch} />
            ))}
          </div>
        )}
      </DetailSection>
    </>
  );
}

export function CustomerDrawer({ customerId, onClose, onEdit }: { customerId: string | null; onClose: () => void; onEdit?: () => void }) {
  const { data, isLoading, error } = useQuery<CustDetail>(customerId ? `/api/customers/${customerId}` : '', undefined, { enabled: !!customerId });
  return (
    <DetailDrawer
      open={!!customerId} onClose={onClose} width="lg"
      title={data?.name ?? 'Customer'}
      subtitle={data?.isPortfolioCompany ? 'Internal company' : 'External customer'}
      isLoading={isLoading} error={error}
      headerRight={data && onEdit ? (
        <button onClick={onEdit} className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">Edit</button>
      ) : undefined}
    >
      {data && (
        <>
          <DetailSection title="Contact">
            {data.contactName && <DetailField label="Contact" value={data.contactName} />}
            <DetailField label="Email" value={data.email ?? '--'} />
            <DetailField label="Phone" value={data.phone ?? '--'} />
            {data.addressLine && <DetailField label="Address" value={data.addressLine} />}
            {data.website && <DetailField label="Website" value={data.website} />}
          </DetailSection>
          <DetailSection title="Terms">
            <DetailField label="Payment terms" value={data.paymentTermsDays != null ? `Net ${data.paymentTermsDays}` : '--'} />
            <DetailField label="Credit limit" value={data.creditLimitCents != null ? formatMoney(data.creditLimitCents) : '--'} mono />
            <DetailField label="Tax exempt" value={data.taxExempt ? 'Yes' : 'No'} />
            <DetailField label="Status" value={data.isActive ? 'Active' : 'Inactive'} />
          </DetailSection>
          <DetailSection title="Accounts receivable">
            <DetailField label="Open balance" value={formatMoney(data.ar.totalOutstanding)} mono />
            <DetailField label="Open invoices" value={data.ar.openInvoiceCount} />
            <DetailField label="Overdue" value={data.ar.overdueCount} />
          </DetailSection>

          <CustomerDossierSections customerId={data.id} survivorName={data.name} />

          <DetailSection title="Statement">
            <StatementActions customerId={data.id} hasEmail={!!data.email} />
          </DetailSection>

          <DetailSection title="Invoice settings">
            <EntityInvoiceSettings scope="CUSTOMER" id={data.id} />
          </DetailSection>

          <DetailSection title="Customer-facing invoice text">
            <InvoiceTextOverrides scope="CUSTOMER" refId={data.id} />
          </DetailSection>
          {data.recentInvoices.length > 0 && (
            <>
              <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Recent invoices</h3>
              <DetailTable columns={[{ key: 'n', label: 'Invoice' }, { key: 'd', label: 'Date' }, { key: 'b', label: 'Balance', align: 'right' }, { key: 's', label: 'Status', align: 'center' }]}>
                {data.recentInvoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-3 py-2 text-sm font-mono text-slate-300">{inv.invoiceNumber}</td>
                    <td className="px-3 py-2 text-xs text-slate-400 font-mono">{inv.invoiceDate}</td>
                    <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(inv.balanceCents)}</td>
                    <td className="px-3 py-2 text-center"><StatusBadge status={inv.status} /></td>
                  </tr>
                ))}
              </DetailTable>
            </>
          )}
        </>
      )}
    </DetailDrawer>
  );
}
