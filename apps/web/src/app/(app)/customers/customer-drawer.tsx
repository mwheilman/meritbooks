'use client';
import { useState } from 'react';
import { Button, Field, Input, Note, Seg, Status, Tag, type StatusKind } from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { EntityInvoiceSettings } from '@/components/entity-invoice-settings';
import { InvoiceTextOverrides } from '@/components/invoice-text-overrides';
import { CustomerPortalAccess } from '@/components/customer-portal-access';
import s from './customers.module.css';

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
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const [mode, setMode] = useState<StatementMode>('open');
  const [asOf, setAsOf] = useState(today);
  // Activity-mode window. Defaults to year-to-date through the as-of date; the
  // route treats an empty `from` as "all history" and an empty `to` as the as-of.
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(today);
  const [sending, setSending] = useState(false);

  const rangeInvalid = mode === 'activity' && !!from && !!to && from > to;

  const query = () => {
    const p = new URLSearchParams({ mode });
    if (asOf && asOf !== today) p.set('as_of', asOf);
    if (mode === 'activity') {
      if (from) p.set('from', from);
      if (to) p.set('to', to);
    }
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
        body: JSON.stringify({ mode, as_of: asOf, ...(mode === 'activity' ? { from, to } : {}) }),
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

  const canAct = !rangeInvalid;
  return (
    <div className={s.statement}>
      <div className={s.dates}>
        <Seg<StatementMode>
          aria-label="Statement type"
          value={mode}
          onChange={setMode}
          items={[
            { value: 'open', label: 'Open items' },
            { value: 'activity', label: 'Activity' },
          ]}
        />
        <span className={s.grow} />
        <Field label="As of" className={s.dateField}>
          <Input type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value || today)} />
        </Field>
      </div>

      {mode === 'open' ? (
        <p className="t-cap">Open-item statement: only invoices with a balance still outstanding, aged as of the date above.</p>
      ) : (
        <div className={s.secBlock}>
          <div className={s.dates}>
            <Field label="From" className={s.dateField} error={rangeInvalid ? 'Must be on or before To.' : undefined}>
              <Input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To" className={s.dateField}>
              <Input type="date" value={to} max={today} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <p className="t-cap">
            {rangeInvalid ? 'The From date must be on or before the To date.' : 'Balance-forward statement: opening balance, every charge and payment in the range, and a running balance.'}
          </p>
        </div>
      )}

      <div className="btn-row">
        <Button icon="file-text" onClick={() => preview(false)} disabled={!canAct}>Preview</Button>
        <Button icon="down" onClick={() => preview(true)} disabled={!canAct}>Download</Button>
        <Button
          onClick={send}
          disabled={sending || !hasEmail || !canAct}
          aria-busy={sending || undefined}
          title={hasEmail ? 'Email this statement to the customer' : 'No customer email on file'}
        >
          {sending ? 'Sending…' : 'Send statement'}
        </Button>
      </div>
      {!hasEmail && (
        <p className="t-cap">Add an email address to enable sending. Preview and download always work.</p>
      )}
    </div>
  );
}

interface CustDetail {
  id: string; name: string; legalName: string; email: string | null; phone: string | null;
  contactName: string | null; addressLine: string | null; website: string | null;
  paymentTermsDays: number | null; creditLimitCents: number | null; taxExempt: boolean;
  isPortfolioCompany: boolean; isActive: boolean; notes: string | null;
  ar: {
    totalOutstanding: number; overdueCount: number; overdueOutstanding: number; openInvoiceCount: number;
    oldestOpenInvoiceDays: number | null; lastPaymentDate: string | null; lastPaymentCents: number | null;
  };
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

const RISK_STYLE: Record<RiskLevel, { kind: StatusKind; label: string }> = {
  low: { kind: 'ready', label: 'Low risk' },
  medium: { kind: 'risk', label: 'Medium risk' },
  high: { kind: 'overdue', label: 'High risk' },
};

const FLAG_LABEL: Record<RiskFlag, string> = {
  SLOW_PAY: 'Slow pay', OVER_LIMIT: 'Over credit limit', APPROACHING_LIMIT: 'Near credit limit',
  DELINQUENT: 'Delinquent', CONCENTRATION: 'Revenue concentration',
};

function pct(n: number | null): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
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
    <div className={s.dup}>
      <div className={s.dupRow}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ minWidth: 0 }}>
            <span className="t-head mb-trunc">{dup.name}</span>
            <span className="tnum ink-2" style={{ flex: 'none' }}>{Math.round(dup.confidence * 100)}% match</span>
          </div>
          <p className={`t-cap ${s.clamp}`} style={{ marginTop: 2 }}>{dup.reason}</p>
          <div className={s.tags}>
            {dup.matchedFields.map((f) => <Tag key={f}>{f.replace('_', ' ')}</Tag>)}
            {dup.amountAtRiskCents > 0 && <Tag><span className="tnum">{formatMoney(dup.amountAtRiskCents)}</span> AR</Tag>}
          </div>
        </div>
        <div style={{ flex: 'none' }}>
          {confirming ? (
            <div className="btn-row" style={{ flexWrap: 'nowrap' }} role="group" aria-label={`Confirm merging ${dup.name}`}>
              <Button variant="danger" onClick={merge} disabled={busy} aria-busy={busy || undefined}>
                {busy ? 'Merging…' : 'Merge'}
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
            </div>
          ) : (
            <Button onClick={() => setConfirming(true)} title={`Merge "${dup.name}" into "${survivorName}"`}>
              Merge in
            </Button>
          )}
        </div>
      </div>
      {confirming && (
        <p className="t-cap" style={{ marginTop: 8 }}>
          “{dup.name}” will be retired and its invoices and payments moved onto “{survivorName}”.
        </p>
      )}
    </div>
  );
}

/** The deterministic dossier: payment behavior, credit utilization, risk badge, duplicates. */
function CustomerDossierSections({ customerId, survivorName }: { customerId: string; survivorName: string }) {
  const { data, isLoading, error, refetch } = useQuery<Dossier>(`/api/customers/${customerId}/dossier`, undefined, { enabled: !!customerId });

  if (isLoading) {
    return (
      <DetailSection title="Customer dossier">
        <div className="wg-loading mb-detail-row" aria-busy="true" style={{ display: 'grid', gap: 8, padding: '12px' }}>
          <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '40%' }} aria-hidden="true" />
          <span className="t-cap" role="status">Working out payment behavior…</span>
        </div>
      </DetailSection>
    );
  }
  if (error || !data) {
    return (
      <DetailSection title="Customer dossier">
        <div className="mb-detail-row">
          <span className="ink-2">The dossier didn’t load.</span>
          <Button variant="quiet" onClick={() => void refetch()}>Try again</Button>
        </div>
      </DetailSection>
    );
  }

  const { behavior: b, credit, risk } = data;
  const rs = RISK_STYLE[risk.level];
  const util = credit.utilizationPct;
  const utilBar = util == null ? 0 : Math.min(100, Math.round(util * 100));
  const utilTone = util != null && util >= 1 ? 'var(--neg)' : util != null && util >= 0.9 ? 'var(--warn)' : 'var(--electric)';

  return (
    <>
      <section className="panel-sec">
        <div className="panel-sec-h">
          <h3>Risk profile</h3>
        </div>
        <div className={s.secBlock}>
          <div className={s.flags}>
            <Status kind={rs.kind}>{rs.label}</Status>
            {risk.flags.map((f) => <Tag key={f} tone="warn">{FLAG_LABEL[f]}</Tag>)}
          </div>
          <Note n={1} kind="Customer risk" title={rs.label} headingLevel={4}>
            {risk.aiSummary || risk.summary}
          </Note>
        </div>
      </section>

      <DetailSection title="Payment behavior">
        <DetailField label="Avg days to pay" value={b.avgDaysToPay != null ? `${b.avgDaysToPay} days` : 'No history'} mono />
        <DetailField label="Median / worst" value={b.medianDaysToPay != null ? `${b.medianDaysToPay} / ${b.worstDaysToPay} days` : '—'} mono />
        <DetailField label="On-time rate" value={pct(b.onTimeRate)} mono />
        <DetailField label="Avg days beyond terms" value={b.avgDaysBeyondTerms != null ? `${b.avgDaysBeyondTerms} days` : '—'} mono />
        <DetailField label="Last payment" value={b.lastPaymentDate ? `${b.lastPaymentDate}${b.lastDaysToPay != null ? ` (${b.lastDaysToPay}d)` : ''}` : '—'} mono />
        <DetailField label="TTM revenue" value={formatMoney(b.ttmRevenueCents)} mono />
        {data.concentrationPct != null && <DetailField label="Share of total revenue" value={pct(data.concentrationPct)} mono />}
        <DetailField label="Overdue" value={b.overdueBalanceCents > 0 ? `${formatMoney(b.overdueBalanceCents)} · ${b.overdueInvoiceCount} inv · ${b.maxOverdueDays}d oldest` : 'None'} mono />
      </DetailSection>

      <DetailSection title="Credit">
        <DetailField label="Credit limit" value={credit.creditLimitCents != null ? formatMoney(credit.creditLimitCents) : 'Not set'} mono />
        <DetailField label="Open AR" value={formatMoney(credit.openArCents)} mono />
        <DetailField label="Available" value={credit.availableCreditCents != null ? formatMoney(credit.availableCreditCents) : '—'} mono />
        {util != null && (
          <div className={s.util}>
            <div className="row row--between">
              <span className="ink-2">Utilization</span>
              <span className="row" style={{ gap: 8 }}>
                {util >= 1 ? <Status kind="overdue">Over limit</Status> : util >= 0.9 ? <Status kind="risk">Near limit</Status> : null}
                <span className="tnum" style={{ fontWeight: 500 }}>{pct(util)}</span>
              </span>
            </div>
            <div className={s.utilTrack} role="img" aria-label={`Credit utilization ${pct(util)}`}>
              <span className={s.utilFill} style={{ width: `${utilBar}%`, background: utilTone }} />
            </div>
          </div>
        )}
        {credit.creditLimitCents == null && (
          <div className="mb-detail-row">
            <span className="t-cap">No credit limit set — set one under Edit to turn on utilization and over-limit alerts.</span>
          </div>
        )}
      </DetailSection>

      <section className="panel-sec">
        <div className="panel-sec-h">
          <h3>{`Possible duplicates${data.possibleDuplicates.length ? ` (${data.possibleDuplicates.length})` : ''}`}</h3>
        </div>
        {data.possibleDuplicates.length === 0 ? (
          <p className="t-cap">No likely duplicate customers found.</p>
        ) : (
          <div className={s.secBlock}>
            <p className="t-cap">Merging moves the other record&apos;s invoices and payments onto this customer, then retires it. It is reconciled before it commits and needs the customers permission.</p>
            <div>
              {data.possibleDuplicates.map((d) => (
                <DuplicateRow key={d.id} survivorId={customerId} survivorName={survivorName} dup={d} onMerged={refetch} />
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

/**
 * AR-at-a-glance strip (task B7): the four numbers a collector wants first —
 * total open, overdue, the age of the oldest open invoice, and the last payment
 * received. Computed server-side over the customer's full open-invoice set so it's
 * exact, not a sample of recent rows.
 */
function ArGlanceStrip({ ar }: { ar: CustDetail['ar'] }) {
  const tiles: Array<{ label: string; value: string; sub: string; attn: boolean }> = [
    {
      label: 'Total open',
      value: formatMoney(ar.totalOutstanding),
      sub: ar.openInvoiceCount > 0 ? `${ar.openInvoiceCount} open invoice${ar.openInvoiceCount !== 1 ? 's' : ''}` : 'Zero balance',
      attn: false,
    },
    {
      label: 'Overdue',
      value: formatMoney(ar.overdueOutstanding),
      sub: ar.overdueCount > 0 ? `${ar.overdueCount} invoice${ar.overdueCount !== 1 ? 's' : ''} past due` : 'Nothing past due',
      attn: ar.overdueOutstanding > 0,
    },
    {
      label: 'Oldest invoice',
      value: ar.oldestOpenInvoiceDays != null ? `${ar.oldestOpenInvoiceDays}d` : '—',
      sub: ar.oldestOpenInvoiceDays != null ? 'since invoiced' : 'None open',
      attn: ar.oldestOpenInvoiceDays != null && ar.oldestOpenInvoiceDays > 60,
    },
    {
      label: 'Last payment',
      value: ar.lastPaymentCents != null ? formatMoney(ar.lastPaymentCents) : '—',
      sub: ar.lastPaymentDate ?? 'No payments yet',
      attn: false,
    },
  ];
  return (
    <div className={s.tiles}>
      {tiles.map((t) => (
        <div key={t.label} className={`${s.tile} ${t.attn ? s.tileAttn : ''}`}>
          <span className="eyebrow">{t.label}</span>
          <span className={`${s.tileValue} tnum`}>{t.value}</span>
          <span className="t-cap mb-trunc">{t.attn ? <b className="ink-2">{t.sub}</b> : t.sub}</span>
        </div>
      ))}
    </div>
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
        <Button onClick={onEdit}>Edit</Button>
      ) : undefined}
    >
      {data && (
        <>
          <ArGlanceStrip ar={data.ar} />
          <DetailSection title="Contact">
            {data.contactName && <DetailField label="Contact" value={data.contactName} />}
            <DetailField label="Email" value={data.email ?? '—'} />
            <DetailField label="Phone" value={data.phone ?? '—'} />
            {data.addressLine && <DetailField label="Address" value={data.addressLine} />}
            {data.website && <DetailField label="Website" value={data.website} />}
          </DetailSection>
          <DetailSection title="Terms">
            <DetailField label="Payment terms" value={data.paymentTermsDays != null ? `Net ${data.paymentTermsDays}` : '—'} />
            <DetailField label="Credit limit" value={data.creditLimitCents != null ? formatMoney(data.creditLimitCents) : '—'} mono />
            <DetailField label="Tax exempt" value={data.taxExempt ? 'Yes' : 'No'} />
            <DetailField label="Status" value={data.isActive ? 'Active' : 'Inactive'} />
          </DetailSection>
          <CustomerDossierSections customerId={data.id} survivorName={data.name} />

          <section className="panel-sec">
            <div className="panel-sec-h"><h3>Statement</h3></div>
            <StatementActions customerId={data.id} hasEmail={!!data.email} />
          </section>

          <section className="panel-sec">
            <div className="panel-sec-h"><h3>Portal access</h3></div>
            <CustomerPortalAccess customerId={data.id} />
          </section>

          <section className="panel-sec">
            <div className="panel-sec-h"><h3>Invoice settings</h3></div>
            <EntityInvoiceSettings scope="CUSTOMER" id={data.id} />
          </section>

          <section className="panel-sec">
            <div className="panel-sec-h"><h3>Customer-facing invoice text</h3></div>
            <InvoiceTextOverrides scope="CUSTOMER" refId={data.id} />
          </section>

          {data.recentInvoices.length > 0 && (
            <section className="panel-sec">
              <div className="panel-sec-h"><h3>Recent invoices</h3></div>
              <DetailTable columns={[{ key: 'n', label: 'Invoice' }, { key: 'd', label: 'Date' }, { key: 'b', label: 'Balance', align: 'right' }, { key: 's', label: 'Status', align: 'center' }]}>
                {data.recentInvoices.map((inv) => (
                  <tr key={inv.id} className="q-row">
                    <td className="tnum">{inv.invoiceNumber}</td>
                    <td className="tnum ink-2">{inv.invoiceDate}</td>
                    <td className="n tnum">{formatMoney(inv.balanceCents)}</td>
                    <td className="mb-c"><StatusBadge status={inv.status} /></td>
                  </tr>
                ))}
              </DetailTable>
            </section>
          )}
        </>
      )}
    </DetailDrawer>
  );
}
