'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Eyebrow,
  Field,
  InlineNotice,
  Input,
  ListPager,
  MoneyInput,
  QueueTable,
  Seg,
  Select,
  Switch,
  Tag,
  api,
  toast,
  useQuery,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import type { LateFeePolicy } from '@/lib/collections/late-fees';
import { usd, type LateFeeRow, type LateFeesResponse, type PoliciesResponse } from './automation-types';
import { CustomerPicker, ScopePicker } from './policy-scope';
import s from './automation.module.css';

type QueueView = 'PROPOSED' | 'APPROVED' | 'REJECTED';
const PAGE = 50;

interface ApiErr {
  error: string;
  details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] };
}

/** "1.50" ↔ 150 bps (no floating-point money: the rate is a percentage, stored as integer bps). */
function bpsToText(bps: number): string {
  return (bps / 100).toFixed(2);
}
function textToBps(t: string): number {
  const m = /^\s*(\d{1,2})(?:\.(\d{0,2}))?\s*$/.exec(t);
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}

function PolicyEditor({ data, onSaved }: { data: PoliciesResponse; onSaved: () => void }) {
  const [scope, setScope] = useState<string | null>(null);
  const overrides = useMemo(() => new Set(data.lateFees.companies.map((c) => c.locationId)), [data]);
  const source = useMemo<LateFeePolicy>(() => (scope ? data.lateFees.companies.find((c) => c.locationId === scope)?.policy ?? data.lateFees.tenant : data.lateFees.tenant), [scope, data]);
  const [p, setP] = useState<LateFeePolicy>(source);
  const [rateText, setRateText] = useState(bpsToText(source.rateBps));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    setP(source);
    setRateText(bpsToText(source.rateBps));
    setErrors([]);
  }, [source]);
  const set = <K extends keyof LateFeePolicy>(k: K, v: LateFeePolicy[K]) => setP((x) => ({ ...x, [k]: v }));

  const rateBps = textToBps(rateText);
  const example = p.method === 'FLAT' ? p.flatFeeCents : Number.isFinite(rateBps) ? Math.floor((100_000 * rateBps + 5000) / 10000) : 0;

  async function save() {
    if (p.method === 'PERCENT_MONTHLY' && !Number.isFinite(rateBps)) {
      setErrors(['Enter the monthly rate as a percentage, e.g. 1.5.']);
      return;
    }
    setSaving(true);
    setErrors([]);
    const res = await api.put<{ ok: boolean }>('/api/automation/policies', {
      kind: 'late_fee',
      policy: {
        location_id: scope,
        enabled: p.enabled,
        method: p.method,
        flat_fee_cents: p.flatFeeCents,
        rate_bps: Number.isFinite(rateBps) ? rateBps : 0,
        grace_days: p.graceDays,
        frequency: p.frequency,
        min_fee_cents: p.minFeeCents,
        max_fee_cents: p.maxFeeCents,
        max_total_per_invoice_cents: p.maxTotalPerInvoiceCents,
        min_balance_cents: p.minBalanceCents,
        apply_to: p.applyTo,
        customer_ids: p.applyTo === 'ALL' ? [] : p.customerIds,
        income_account_id: p.incomeAccountId,
      },
    });
    setSaving(false);
    if (res.error) {
      const e = res.error as unknown as ApiErr;
      const msgs = [...(e.details?.formErrors ?? []), ...Object.values(e.details?.fieldErrors ?? {}).flat()];
      setErrors(msgs.length ? msgs : [e.error]);
      toast.error(e.error);
      return;
    }
    toast(p.enabled ? 'Late-fee policy saved — fees are proposed each morning for your approval.' : 'Saved. Late fees are off.');
    onSaved();
  }

  return (
    <div className={s.section}>
      <Eyebrow>{['01', 'Late-fee policy']}</Eyebrow>
      <div className={s.form} style={{ marginTop: 8 }}>
        <div className={s.row2}>
          <ScopePicker companies={data.companies} overrides={overrides} value={scope} onChange={setScope} />
          <Field label="Late fees" help="Fees are only ever proposed — nothing is charged until you approve.">
            <Switch label={p.enabled ? 'On' : 'Off'} checked={p.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          </Field>
        </div>
        <div className={s.row3}>
          <Field label="Charge">
            <Seg<'PERCENT_MONTHLY' | 'FLAT'>
              aria-label="Late-fee method"
              value={p.method}
              onChange={(v) => set('method', v)}
              items={[
                { value: 'PERCENT_MONTHLY', label: '% per month' },
                { value: 'FLAT', label: 'Flat fee' },
              ]}
            />
          </Field>
          {p.method === 'PERCENT_MONTHLY' ? (
            <Field label="Monthly rate (%)" help="At most 10% a month. Check your state’s limit.">
              <Input inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} aria-invalid={!Number.isFinite(rateBps)} />
            </Field>
          ) : (
            <Field label="Flat fee">
              <MoneyInput valueCents={p.flatFeeCents} onChangeCents={(c) => set('flatFeeCents', Math.max(0, c ?? 0))} />
            </Field>
          )}
          <Field label="How often">
            <Select value={p.frequency} onChange={(e) => set('frequency', e.target.value as LateFeePolicy['frequency'])}>
              <option value="MONTHLY">Every month it stays overdue</option>
              <option value="ONCE">Once per invoice</option>
            </Select>
          </Field>
        </div>
        <div className={s.row3}>
          <Field label="Grace period (days after due)">
            <Input type="number" min={0} max={365} value={String(p.graceDays)} onChange={(e) => set('graceDays', Math.max(0, Math.min(365, Math.trunc(Number(e.target.value) || 0))))} />
          </Field>
          <Field label="Minimum fee">
            <MoneyInput valueCents={p.minFeeCents} onChangeCents={(c) => set('minFeeCents', Math.max(0, c ?? 0))} />
          </Field>
          <Field label="Maximum per fee" help="Blank = no maximum.">
            <MoneyInput valueCents={p.maxFeeCents} onChangeCents={(c) => set('maxFeeCents', c)} />
          </Field>
        </div>
        <div className={s.row3}>
          <Field label="Lifetime cap per invoice" help="Blank = no cap.">
            <MoneyInput valueCents={p.maxTotalPerInvoiceCents} onChangeCents={(c) => set('maxTotalPerInvoiceCents', c && c > 0 ? c : null)} />
          </Field>
          <Field label="Only on balances of at least">
            <MoneyInput valueCents={p.minBalanceCents} onChangeCents={(c) => set('minBalanceCents', Math.max(0, c ?? 0))} />
          </Field>
          <Field label="Credit fees to" help="An income account (revenue or other income).">
            <Select value={p.incomeAccountId ?? ''} onChange={(e) => set('incomeAccountId', e.target.value || null)}>
              <option value="">Pick an income account…</option>
              {data.incomeAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className={s.row2}>
          <Field label="Which customers">
            <Select value={p.applyTo} onChange={(e) => set('applyTo', e.target.value as LateFeePolicy['applyTo'])}>
              <option value="ALL">Every customer</option>
              <option value="INCLUDE">Only the customers I pick</option>
              <option value="EXCLUDE">Everyone except the customers I pick</option>
            </Select>
          </Field>
          <p className="t-cap" style={{ alignSelf: 'end' }}>
            Example: an overdue {usd(100_000)} invoice is charged {usd(Math.max(p.minFeeCents, p.maxFeeCents != null ? Math.min(example, p.maxFeeCents) : example))}
            {p.frequency === 'MONTHLY' ? ' each month' : ' once'}. Fees are never charged on a fee, and never on a disputed invoice.
          </p>
        </div>
        {p.applyTo !== 'ALL' && (
          <CustomerPicker
            label={p.applyTo === 'INCLUDE' ? 'Charge late fees to' : 'Never charge late fees to'}
            customers={data.customers}
            selected={p.customerIds}
            onChange={(ids) => set('customerIds', ids)}
          />
        )}
        {errors.length > 0 && (
          <InlineNotice tone="neg" title="Not saved">
            {errors.join(' ')}
          </InlineNotice>
        )}
        <div className={s.actions}>
          {scope && overrides.has(scope) && (
            <Button variant="quiet" onClick={() => setConfirmRemove(true)}>
              Use the default instead
            </Button>
          )}
          <Button variant="primary" icon="check" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : scope ? 'Save for this company' : 'Save the default'}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Drop this company’s own late-fee policy?"
        confirmLabel="Use the default"
        tone="danger"
        onConfirm={async () => {
          setConfirmRemove(false);
          const res = await api.put<{ ok: boolean }>('/api/automation/policies', { kind: 'remove_company', policy_kind: 'late_fee', location_id: scope });
          if (res.error) toast.error(res.error.error);
          else {
            toast('This company now uses the default late-fee policy.');
            onSaved();
          }
        }}
      >
        Fees already proposed stay in the queue; new ones follow the default.
      </ConfirmDialog>
    </div>
  );
}

function FeeQueue() {
  const [view, setView] = useState<QueueView>('PROPOSED');
  const [offset, setOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null);
  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [view]);
  const { data, error, isLoading, refetch } = useQuery<LateFeesResponse>(
    '/api/collections/late-fees',
    { status: view, limit: String(PAGE), offset: String(offset) },
    { key: String(refreshKey), scope: false },
  );
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const picked = rows.filter((r) => selected.has(r.id));
  const pickedCents = picked.reduce((sum, r) => sum + r.feeCents, 0);

  const decide = useCallback(
    async (action: 'approve' | 'reject', note?: string) => {
      const res = await api.post<{ approved: number; rejected: number; invoices: Array<{ invoice_number: string }>; errors: string[] }>('/api/collections/late-fees', {
        ids: [...selected],
        action,
        note: note || undefined,
      });
      if (res.error) {
        toast.error(res.error.error);
        return;
      }
      const r = res.data;
      if (r) {
        if (action === 'approve') toast(`Approved ${r.approved} fee(s) → ${r.invoices.map((i) => i.invoice_number).join(', ') || 'no invoice'}.`);
        else toast(`Rejected ${r.rejected} fee(s).`);
        if (r.errors.length) toast.error(r.errors[0]);
      }
      setSelected(new Set());
      setRefreshKey((k) => k + 1);
    },
    [selected],
  );

  const columns = useMemo<QueueColumn<LateFeeRow>[]>(
    () => [
      {
        id: 'who',
        header: 'Invoice',
        cell: (r) => (
          <>
            <span className="l1">
              {r.invoiceNumber} · {r.customer}
            </span>
            <span className="l2">
              {r.company} · {r.daysPastDue} days past due · {r.periodKey === 'ONCE' ? 'one-time fee' : `for ${r.periodKey}`}
            </span>
          </>
        ),
      },
      { id: 'base', header: 'Overdue balance', width: 150, numeric: true, cell: (r) => <span className="tnum">{usd(r.baseCents)}</span> },
      {
        id: 'how',
        header: 'Rule',
        width: 130,
        cell: (r) => <span className="ink-2">{r.method === 'FLAT' ? 'Flat fee' : `${((r.rateBps ?? 0) / 100).toFixed(2)}% / mo`}</span>,
      },
      { id: 'fee', header: 'Fee', width: 120, numeric: true, cell: (r) => <span className="tnum">{usd(r.feeCents)}</span> },
      {
        id: 'out',
        header: view === 'PROPOSED' ? 'Proposed' : 'Decided',
        width: 170,
        cell: (r) =>
          r.status === 'APPROVED' ? (
            <Tag tone="pos">{r.financeChargeInvoiceNumber ? `On ${r.financeChargeInvoiceNumber}` : 'Approved'}</Tag>
          ) : r.status === 'REJECTED' ? (
            <span className="ink-2" title={r.decisionNote ?? undefined}>Rejected · {r.decisionNote ?? ''}</span>
          ) : (
            <span className="ink-2">{r.asOf}</span>
          ),
      },
    ],
    [view],
  );

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Eyebrow>{['02', 'Late fees to approve']}</Eyebrow>
        <div className={s.grow} />
        <Seg<QueueView>
          aria-label="Late-fee queue"
          value={view}
          onChange={setView}
          items={[
            { value: 'PROPOSED', label: 'To approve' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'REJECTED', label: 'Rejected' },
          ]}
        />
      </div>
      {error ? (
        <div role="alert">
          <p className="t-head">Couldn’t load late fees.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : isLoading && !data ? (
        <p className="t-cap" role="status">Loading late fees…</p>
      ) : rows.length === 0 ? (
        <p className="ink-2">
          {view === 'PROPOSED' ? 'Nothing to approve. When the policy is on, fees for overdue invoices are proposed here each morning.' : 'Nothing here yet.'}
        </p>
      ) : (
        <>
          <QueueTable
            aria-label="Late fees"
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            selectable={view === 'PROPOSED'}
            selected={selected}
            onSelectedChange={setSelected}
            bulkSummary={(rs) => [`${rs.length} selected`, usd(rs.reduce((sum, r) => sum + r.feeCents, 0))]}
            bulkActions={() => (
              <>
                <Button variant="primary" onClick={() => setConfirm('approve')}>
                  Approve
                </Button>
                <Button onClick={() => setConfirm('reject')}>Reject</Button>
              </>
            )}
          />
          {data && <ListPager page={Math.floor(offset / PAGE) + 1} perPage={PAGE} total={data.total} onPage={(pg) => setOffset((pg - 1) * PAGE)} noun="fees" />}
          {view === 'PROPOSED' && (
            <p className="t-cap" style={{ marginTop: 8 }}>
              {data?.total ?? 0} proposed · {usd(data?.totalFeeCents ?? 0)} on this page. Select fees (X) to approve or reject them.
            </p>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirm === 'approve'}
        onClose={() => setConfirm(null)}
        title={`Approve ${picked.length} late fee${picked.length === 1 ? '' : 's'} (${usd(pickedCents)})?`}
        confirmLabel="Approve and invoice"
        tone="primary"
        onConfirm={async () => {
          setConfirm(null);
          await decide('approve');
        }}
      >
        Each company + customer gets one finance-charge invoice, posted to AR and credited to your late-fee income account. Send it from Invoices like any other invoice.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'reject'}
        onClose={() => setConfirm(null)}
        title={`Reject ${picked.length} late fee${picked.length === 1 ? '' : 's'}?`}
        confirmLabel="Reject"
        tone="danger"
        reason={{ label: 'Why? (kept with the fee)', minLength: 3, placeholder: 'Good customer — waived' }}
        onConfirm={async (reason) => {
          setConfirm(null);
          await decide('reject', reason);
        }}
      >
        Rejected fees are never proposed again for that month.
      </ConfirmDialog>
    </div>
  );
}

export function LateFeesTab({ data, onSaved }: { data: PoliciesResponse; onSaved: () => void }) {
  return (
    <div className={s.form}>
      <PolicyEditor data={data} onSaved={onSaved} />
      <FeeQueue />
    </div>
  );
}
