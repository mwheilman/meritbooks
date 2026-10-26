'use client';

import { useState, useCallback } from 'react';
import { Button, Field, InlineNotice, Input, PanelSection, Select, Tag, cx } from '@meritbooks/merit-ui';
import { StatusBadge, CurrencyTag } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { DetailDrawer, DetailTable } from '@/components/detail-drawer';
import { AttachmentsPanel } from '@/components/documents/attachments-panel';
import { ExplainPanel } from '@/components/explain-panel';
import s from './bills.module.css';

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
    currency: string | null;
    fx_rate: number | null;
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
  homeCurrency?: string;
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

  // Escape closes the drawer (handled by DetailDrawer).

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
  const billCcy = (bill?.currency ?? 'USD').toUpperCase();
  const homeCcy = (data?.homeCurrency ?? 'USD').toUpperCase();
  const isForeignBill = billCcy !== homeCcy;
  const vendorName = bill ? (bill.vendor?.display_name ?? bill.vendor?.name ?? 'Vendor') : 'Bill';

  const canSchedule = !!bill && (bill.status === 'APPROVED' || bill.status === 'SCHEDULED');
  const canPay = !!bill && ['APPROVED', 'SCHEDULED', 'PARTIALLY_PAID'].includes(bill.status);
  const canVoid = !!bill && bill.status !== 'VOIDED' && bill.status !== 'PAID' && bill.amount_paid_cents === 0;
  const isFinal = !!bill && (bill.status === 'PAID' || bill.status === 'VOIDED');

  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={bill ? vendorName : 'Bill'}
      subtitle={bill ? [bill.bill_number ?? 'No bill number', bill.location?.short_code, `billed ${bill.bill_date}`].filter(Boolean).join(' · ') : null}
      isLoading={isLoading && !data}
      headerRight={bill ? <StatusBadge status={bill.status} /> : undefined}
      width="lg"
    >
      {error || !bill ? (
        <div className="wg-state" role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <span className="t-head">This bill didn&apos;t load</span>
          <p>{error ?? 'Bill not found'}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : (
        <>
          {/* Summary */}
          <dl className={s.summary}>
            <dt className="ink-2">Total</dt>
            <dd>
              <span className={s.due}>
                <CurrencyTag code={billCcy} homeCurrency={homeCcy} onlyForeign />
                <span className={s.summaryTotal}>{formatMoney(bill.total_cents, { currency: billCcy })}</span>
              </span>
            </dd>
            <dt className="ink-2">Paid</dt>
            <dd>{formatMoney(bill.amount_paid_cents, { currency: billCcy })}</dd>
            <dt className={s.strong}>Balance due</dt>
            <dd className={s.strong}>{formatMoney(balance, { currency: billCcy })}</dd>
            <dt className="ink-2">Due</dt>
            <dd>{bill.due_date}</dd>
            {bill.scheduled_payment_date && (
              <>
                <dt className="ink-2">Scheduled to pay</dt>
                <dd>{bill.scheduled_payment_date}</dd>
              </>
            )}
            {isForeignBill && (
              <dd className="t-cap" style={{ gridColumn: '1 / -1', textAlign: 'left' }}>
                Amounts in {billCcy} · reported in {homeCcy}
                {bill.fx_rate ? ` at rate ${bill.fx_rate}` : ''}
              </dd>
            )}
          </dl>

          {bill.status === 'ON_HOLD' && (
            <PanelSection title="Payment hold">
              <InlineNotice tone="neg" title="On hold.">
                {bill.payment_hold_reason ?? 'On hold for vendor compliance. Resolve the vendor docs, or release this bill with an override.'}
              </InlineNotice>
              {!showRelease ? (
                <div className={s.inlineForm}>
                  <Button variant="quiet" onClick={() => setShowRelease(true)}>
                    Release hold (override)
                  </Button>
                </div>
              ) : (
                <div className={s.inlineForm}>
                  <Field label="Reason for the override">
                    <Input value={holdReason} onChange={(e) => setHoldReason(e.target.value)} placeholder="Why this bill can be paid now" autoFocus />
                  </Field>
                  <Button
                    variant="danger"
                    disabled={!holdReason || busy !== null}
                    onClick={() => post({ action: 'release_hold', reason: holdReason }, 'Release hold')}
                  >
                    {busy === 'Release hold' ? 'Releasing…' : 'Release hold'}
                  </Button>
                  <Button variant="quiet" onClick={() => { setShowRelease(false); setHoldReason(''); }}>
                    Cancel
                  </Button>
                </div>
              )}
              <p className="t-cap" style={{ marginTop: 8 }}>One-time release for this bill. Audit-logged.</p>
            </PanelSection>
          )}
          {bill.status === 'VOIDED' && bill.void_reason && (
            <PanelSection>
              <InlineNotice title="Voided.">{bill.void_reason}</InlineNotice>
            </PanelSection>
          )}

          {/* AP policy evaluation — deterministic engine vs the ACTIVE ruleset */}
          {data?.policy?.active && (data.policy.violations.length > 0 || data.policy.requiredApprovalTier) && (
            <PanelSection
              title="AP policy"
              meta={data.policy.requiredApprovalTier ? <Tag tone="warn">Requires {data.policy.requiredApprovalTier}</Tag> : undefined}
            >
              <InlineNotice
                tone={data.policy.blocked ? 'neg' : data.policy.violations.length > 0 ? 'warn' : 'default'}
                title={`${data.policy.active.name} v${data.policy.active.version}.`}
              >
                {data.policy.violations.length === 0 ? (
                  'No policy violations.'
                ) : (
                  <ul className={s.violations}>
                    {data.policy.violations.map((v, i) => (
                      <li key={i}>
                        <Tag tone={v.severity === 'BLOCK' ? 'neg' : 'warn'}>{v.severity === 'BLOCK' ? 'Blocks' : 'Warns'}</Tag>
                        <span>{v.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {data.policy.blocked && (
                  <p style={{ marginTop: 8 }}>
                    <b>Blocked by policy.</b> Approval requires an audited override reason.
                  </p>
                )}
              </InlineNotice>
            </PanelSection>
          )}

          {/* Approver routing */}
          <PanelSection title="Routed approver">
            <div className="mb-detail-rows">
              <div className="mb-detail-row">
                <span className="ink-2">Approver</span>
                <span>
                  {bill.status === 'PENDING' || bill.status === 'ON_HOLD'
                    ? (data?.approver.type ? APPROVER_LABEL[data.approver.type] : 'Accounting')
                    : APPROVER_LABEL[data?.approver.type ?? ''] ?? 'Accounting'}
                  {data?.approver.name && <span className="ink-2"> · {data.approver.name}</span>}
                </span>
              </div>
            </div>
            {(bill.status === 'PENDING' || bill.status === 'ON_HOLD') && (
              <div className={s.inlineForm}>
                <Select
                  aria-label="Re-route to"
                  value={overrideType}
                  onChange={(e) => { setOverrideType(e.target.value); setOverrideRef(''); }}
                >
                  <option value="">Re-route to…</option>
                  <option value="ACCOUNTING">Accounting</option>
                  <option value="RESPONSIBLE_PARTY">Responsible party</option>
                  <option value="PM_LEADER">PM / Leader</option>
                </Select>
                {(overrideType === 'RESPONSIBLE_PARTY' || overrideType === 'PM_LEADER') && (
                  <Select aria-label="Person" value={overrideRef} onChange={(e) => setOverrideRef(e.target.value)}>
                    <option value="">Person…</option>
                    {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
                  </Select>
                )}
                <Button
                  onClick={() => post({ action: 'override_approver', approver_type: overrideType, approver_ref: overrideRef || null }, 'Re-route')}
                  disabled={!overrideType || busy !== null}
                >
                  {busy === 'Re-route' ? 'Re-routing…' : 'Re-route'}
                </Button>
              </div>
            )}
          </PanelSection>

          {/* Lines */}
          <PanelSection
            title="Lines"
            meta={<span className="t-cap tnum">{data?.lines.length ?? 0}</span>}
          >
            <DetailTable columns={[{ key: 'line', label: 'Line' }, { key: 'amount', label: 'Amount', align: 'right' }]}>
              {data?.lines.map((l) => (
                <tr key={l.id}>
                  <td className={s.lineCell}>
                    <span className="l1">{l.description || l.account?.name || '—'}</span>
                    {l.account && <span className="l2 tnum">{l.account.account_number} · {l.account.name}</span>}
                    {l.job && (
                      <Tag tone="ai" style={{ marginTop: 4 }}>
                        Job {l.job.job_number} · {l.job.name}
                      </Tag>
                    )}
                  </td>
                  <td className={cx('n', s.lineCell)}>{formatMoney(l.amount_cents, { currency: billCcy })}</td>
                </tr>
              ))}
            </DetailTable>
            {data && data.attributions.length > 0 && (
              <p className="t-cap" style={{ marginTop: 8 }}>
                {data.attributions.filter((a) => a.lifecycle === 'CLEARED').length} of {data.attributions.length} job cost(s) cleared to Projects
              </p>
            )}
          </PanelSection>

          {/* Ledger-grounded "why this bill posted the way it did" */}
          <PanelSection>
            <ExplainPanel kind="BILL" id={bill.id} />
          </PanelSection>

          {/* Retained source documents for this bill */}
          <PanelSection>
            <AttachmentsPanel entityType="bill" entityId={bill.id} defaultDocType="BILL" title="Documents" />
          </PanelSection>

          {/* Footer actions (sticky at the bottom of the drawer) */}
          <div className={s.foot}>
            {showVoid ? (
              <div className={s.footRow}>
                <Field label="Reason for voiding" className={s.grow}>
                  <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Why this bill is void" autoFocus />
                </Field>
                <Button onClick={() => setShowVoid(false)}>Cancel</Button>
                <Button
                  variant="danger"
                  disabled={!voidReason || busy !== null}
                  onClick={async () => { if (await post({ action: 'void', reason: voidReason }, 'Void')) onClose(); }}
                >
                  {busy === 'Void' ? 'Voiding…' : 'Void bill'}
                </Button>
              </div>
            ) : (
              <>
                {bill.status === 'PENDING' && (
                  <div className={s.footRow}>
                    <Button variant="primary" disabled={busy !== null} onClick={() => post({ action: 'approve' }, 'Approve')} aria-busy={busy === 'Approve' || undefined}>
                      {busy === 'Approve' ? 'Approving…' : 'Approve & post'}
                    </Button>
                  </div>
                )}

                {canSchedule && (
                  <div className={s.footRow}>
                    <Input
                      type="date"
                      aria-label="Payment date"
                      className="tnum"
                      value={scheduleDate}
                      onChange={(e) => setScheduleDate(e.target.value)}
                    />
                    <Button
                      variant="primary"
                      disabled={!scheduleDate || busy !== null}
                      onClick={() => post({ action: 'schedule', scheduled_payment_date: scheduleDate }, 'Schedule')}
                    >
                      {busy === 'Schedule' ? 'Scheduling…' : bill.status === 'SCHEDULED' ? 'Reschedule' : 'Schedule payment'}
                    </Button>
                  </div>
                )}

                {canPay && (
                  <div className={s.footRow}>
                    <span className={s.money}>
                      <span aria-hidden="true">$</span>
                      <Input
                        type="number"
                        aria-label="Payment amount"
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        placeholder={(balance / 100).toFixed(2)}
                      />
                    </span>
                    <Button
                      variant={canSchedule ? 'default' : 'primary'}
                      disabled={busy !== null}
                      onClick={() => post({ action: 'pay', amount_cents: Math.round(parseFloat(payAmount || String(balance / 100)) * 100) }, 'Payment')}
                    >
                      {busy === 'Payment' ? 'Recording…' : 'Record payment'}
                    </Button>
                  </div>
                )}

                {canVoid && (
                  <div className={s.footRow}>
                    <span className={s.grow} />
                    <Button variant="quiet" onClick={() => setShowVoid(true)} disabled={busy !== null}>
                      Void bill
                    </Button>
                  </div>
                )}

                {isFinal && (
                  <p className="t-cap">No further actions for {bill.status.toLowerCase()} bills.</p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </DetailDrawer>
  );
}
