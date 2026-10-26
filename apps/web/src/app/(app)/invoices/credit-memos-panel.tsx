'use client';

import { useState, useEffect, useMemo } from 'react';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  InlineNotice,
  Input,
  Keyhints,
  MoneyInput,
  Seg,
  Select,
  Status,
  Tag,
  cx,
  useListKeynav,
  type PipKind,
  type StatusKind,
} from '@meritbooks/merit-ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { EmptyState, TableSkeleton } from '@/components/ui';
import s from './invoices.module.css';

// ─── Types ────────────────────────────────────────────────────────────
interface MemoRow {
  id: string;
  creditNumber: string | null;
  creditDate: string;
  status: string;
  memo: string | null;
  reason: string | null;
  totalCents: number;
  appliedCents: number;
  unappliedCents: number;
  invoiceId: string | null;
  customer: { id: string; name: string } | null;
  location: { id: string; name: string; shortCode: string } | null;
}
interface LocationOption { id: string; name: string; short_code: string }
interface CustomerOption { id: string; name: string }
interface AccountOption { id: string; account_number: string; name: string }

// ─── Memo status: pip shape + word (covers APPLIED) ──────────────────
const MEMO_LOOK: Record<string, { kind: StatusKind; pip?: PipKind; label: string }> = {
  DRAFT: { kind: 'track', pip: 'closed', label: 'Draft' },
  POSTED: { kind: 'track', pip: 'open', label: 'Posted' },
  APPLIED: { kind: 'ready', label: 'Applied' },
  VOIDED: { kind: 'track', pip: 'closed', label: 'Voided' },
};

function MemoStatusBadge({ status }: { status: string }) {
  const c = MEMO_LOOK[status] ?? MEMO_LOOK.DRAFT;
  return <Status kind={c.kind} pip={c.pip}>{c.label}</Status>;
}

type MemoFilter = 'ALL' | 'DRAFT' | 'POSTED' | 'APPLIED' | 'VOIDED';

export interface CreditMemoPrefill {
  invoiceId?: string;
  customerId?: string;
  locationId?: string;
}

// ─── Panel ────────────────────────────────────────────────────────────
export function CreditMemosPanel({ prefill, onConsumePrefill }: {
  prefill?: CreditMemoPrefill | null;
  onConsumePrefill?: () => void;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [filter, setFilter] = useState<MemoFilter>('ALL');

  // Open the create modal pre-filled when the parent hands us an invoice context.
  useEffect(() => {
    if (prefill) setShowCreate(true);
  }, [prefill]);

  const { data, isLoading, error, refetch } = useQuery<{
    data: MemoRow[];
    counts: Record<string, number>;
    openCreditCents: number;
  }>(`/api/credit-memos?_k=${refreshKey}`);

  const memos = useMemo(() => {
    const all = data?.data ?? [];
    return filter === 'ALL' ? all : all.filter((m) => m.status === filter);
  }, [data, filter]);
  const counts = data?.counts ?? {};
  const refresh = () => { setRefreshKey((k) => k + 1); setShowCreate(false); setDetailId(null); };

  const { activeIndex, setActiveIndex, rowProps } = useListKeynav({
    count: memos.length,
    onOpen: (i) => { const m = memos[i]; if (m) setDetailId(m.id); },
    enabled: !showCreate && !detailId,
    owner: 'Credit memos',
  });

  return (
    <div>
      <div className={s.sectionHead}>
        <div>
          <h2 className="t-section">Credit memos</h2>
          <p>Issue customer credits, post them to the GL, and apply them against open invoices.</p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setShowCreate(true)}>New credit memo</Button>
      </div>

      <div className={s.toolbar}>
        <Seg<MemoFilter>
          aria-label="Credit memo status"
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'ALL', label: 'All', count: counts.ALL ?? 0 },
            { value: 'DRAFT', label: 'Draft', count: counts.DRAFT ?? 0 },
            { value: 'POSTED', label: 'Posted', count: counts.POSTED ?? 0 },
            { value: 'APPLIED', label: 'Applied', count: counts.APPLIED ?? 0 },
            { value: 'VOIDED', label: 'Voided', count: counts.VOIDED ?? 0 },
          ]}
        />
        <span className={s.toolbarSp} />
        <span className="fig" style={{ alignItems: 'flex-end' }}>
          <span className="fig-l">Open credit</span>
          {isLoading && !data
            ? <span className={cx('mb-skel', s.figSkel)} aria-hidden="true" />
            : <span className="fig-v fig-v--dense tnum">{formatMoney(data?.openCreditCents ?? 0)}</span>}
          <span className="fig-vs tnum">{counts.POSTED ?? 0} posted, not yet fully applied</span>
        </span>
      </div>

      {error ? (
        <div className={cx('surface', s.state)}>
          <div className="wg-state" role="alert">
            <Tag tone="neg">Not loaded</Tag>
            <span className="t-head">Credit memos didn&apos;t load</span>
            <p>{error}</p>
            <Button onClick={() => void refetch()}>Try again</Button>
          </div>
        </div>
      ) : isLoading && !data ? (
        <TableSkeleton rows={5} cols={7} />
      ) : memos.length === 0 ? (
        <div className="surface">
          {filter !== 'ALL' && (counts.ALL ?? 0) > 0 ? (
            <EmptyState
              title="No credit memos in this view"
              description="Nothing has this status. Show every credit memo to see the rest."
              action={{ label: 'Show all', onClick: () => setFilter('ALL') }}
            />
          ) : (
            <EmptyState
              title="No credit memos"
              description="Create a credit memo to reverse revenue and reduce a customer's balance."
              action={{ label: 'New credit memo', onClick: () => setShowCreate(true) }}
            />
          )}
        </div>
      ) : (
        <>
          <div className={s.tableWrap}>
            <table className={cx('tbl', 'tbl-q', s.tableNarrow)} aria-label="Credit memos">
              <colgroup>
                <col style={{ width: 140 }} />
                <col />
                <col style={{ width: 200 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 132 }} />
                <col style={{ width: 132 }} />
                <col style={{ width: 132 }} />
                <col style={{ width: 120 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Credit</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Company</th>
                  <th scope="col">Date</th>
                  <th scope="col" className="n">Total</th>
                  <th scope="col" className="n">Applied</th>
                  <th scope="col" className="n">Open</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {memos.map((m, i) => (
                  <tr
                    key={m.id}
                    {...rowProps(i)}
                    onClick={() => { setActiveIndex(i); setDetailId(m.id); }}
                    className={cx('q-row', s.row, i === activeIndex && 'is-cursor')}
                    aria-current={i === activeIndex || undefined}
                  >
                    <td className="tnum" style={{ fontWeight: 600 }}>{m.creditNumber ?? '—'}</td>
                    <td>{m.customer?.name ?? '—'}</td>
                    <td className="ink-2">{m.location?.name ?? '—'}</td>
                    <td className="tnum ink-2">{m.creditDate}</td>
                    <td className="n">{formatMoney(m.totalCents)}</td>
                    <td className="n ink-2">{formatMoney(m.appliedCents)}</td>
                    <td className="n" style={{ fontWeight: 600 }}>{formatMoney(m.unappliedCents)}</td>
                    <td><MemoStatusBadge status={m.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={s.tableFoot}>
            <Keyhints hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open' }]} />
          </div>
        </>
      )}

      {showCreate && (
        <CreateCreditMemoModal
          prefill={prefill ?? null}
          onClose={() => { setShowCreate(false); onConsumePrefill?.(); }}
          onCreated={() => { onConsumePrefill?.(); refresh(); }}
        />
      )}
      <CreditMemoDrawer memoId={detailId} onClose={() => setDetailId(null)} onChanged={refresh} />
    </div>
  );
}

// ─── Detail drawer with Post / Apply / Void ───────────────────────────
interface MemoDetail {
  id: string; creditNumber: string; creditDate: string; status: string;
  memo: string | null; reason: string | null;
  subtotalCents: number; taxCents: number; totalCents: number;
  appliedCents: number; unappliedCents: number;
  glEntryId: string | null; invoiceId: string | null; customerId: string;
  customerName: string; locationName: string; locationCode: string;
  linkedInvoice: { id: string; invoiceNumber: string; balanceCents: number; status: string } | null;
  lines: { id: string; description: string | null; amountCents: number; accountNumber: string; accountName: string }[];
}
interface OpenInvoiceOption { id: string; invoiceNumber: string; balanceCents: number; customerId: string }

function CreditMemoDrawer({ memoId, onClose, onChanged }: {
  memoId: string | null; onClose: () => void; onChanged: () => void;
}) {
  const { data, isLoading, error, refetch } = useQuery<MemoDetail>(
    memoId ? `/api/credit-memos/${memoId}` : '', undefined, { enabled: !!memoId },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [applyInvoiceId, setApplyInvoiceId] = useState('');

  useEffect(() => { setApplyInvoiceId(''); }, [memoId]);

  // For an unlinked POSTED credit, offer the customer's other open invoices.
  const needsPicker = !!data && data.status === 'POSTED' && !data.linkedInvoice;
  const { data: invResp } = useQuery<{ data: { id: string; invoiceNumber: string; balanceCents: number; customer: { id: string } | null; status: string }[] }>(
    needsPicker && data ? `/api/invoices?customer_id=${data.customerId}` : '', undefined, { enabled: needsPicker },
  );
  const openInvoices: OpenInvoiceOption[] = useMemo(() => {
    if (!invResp || !data) return [];
    return invResp.data
      .filter((i) => i.balanceCents > 0 && i.status !== 'DRAFT' && i.status !== 'VOIDED')
      .map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, balanceCents: i.balanceCents, customerId: i.customer?.id ?? '' }));
  }, [invResp, data]);

  async function act(path: string, body?: unknown, ok?: string) {
    if (!memoId) return;
    setBusy(path);
    try {
      const res = await fetch(`/api/credit-memos/${memoId}/${path}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result.ok) {
        addToast('success', ok ?? 'Done');
        refetch(); onChanged();
      } else {
        addToast('error', result.error ?? 'Action failed');
      }
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusy(null);
    }
  }

  const applyTarget = data?.linkedInvoice?.id || applyInvoiceId;

  const [confirmVoid, setConfirmVoid] = useState(false);

  return (
    <DetailDrawer
      open={!!memoId}
      onClose={onClose}
      width="lg"
      title={data?.creditNumber ? `Credit ${data.creditNumber}` : 'Credit memo'}
      subtitle={data ? `${data.customerName}${data.locationCode ? ` · ${data.locationCode}` : ''}` : null}
      isLoading={isLoading}
      error={error}
      headerRight={data ? <MemoStatusBadge status={data.status} /> : undefined}
    >
      {data && (
        <>
          <DetailSection title="Credit memo">
            <DetailField label="Customer" value={data.customerName || '--'} />
            <DetailField label="Company" value={data.locationName || '--'} />
            <DetailField label="Date" value={data.creditDate} mono />
            {data.reason && <DetailField label="Reason" value={data.reason} />}
            {data.memo && <DetailField label="Memo" value={data.memo} />}
            {data.linkedInvoice && (
              <DetailField label="Linked invoice" value={`${data.linkedInvoice.invoiceNumber} · open ${formatMoney(data.linkedInvoice.balanceCents)}`} />
            )}
          </DetailSection>

          <section className="panel-sec">
            <div className="panel-sec-h"><h3>Lines ({data.lines.length})</h3></div>
            <DetailTable columns={[{ key: 'd', label: 'Description' }, { key: 'a', label: 'Amount', align: 'right' }]}>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td className={s.lineCell}>
                    <div>{l.description || 'Credit'}</div>
                    <div className="t-cap tnum">{l.accountNumber} · {l.accountName}</div>
                  </td>
                  <td className="n">{formatMoney(l.amountCents)}</td>
                </tr>
              ))}
            </DetailTable>
          </section>

          <DetailSection title="Totals">
            <DetailField label="Subtotal" value={formatMoney(data.subtotalCents)} mono />
            <DetailField label="Tax" value={formatMoney(data.taxCents)} mono />
            <DetailField label="Total credit" value={formatMoney(data.totalCents)} mono />
            <DetailField label="Applied" value={formatMoney(data.appliedCents)} mono />
            <DetailField label="Open credit" value={<b>{formatMoney(data.unappliedCents)}</b>} mono />
          </DetailSection>

          {/* Actions by lifecycle state */}
          <section className="panel-sec">
            {data.status === 'DRAFT' && (
              <div className="btn-row">
                <Button variant="primary" onClick={() => act('post', undefined, 'Credit memo posted to GL')} disabled={busy === 'post'} aria-busy={busy === 'post' || undefined}>
                  {busy === 'post' ? 'Posting…' : 'Post to GL'}
                </Button>
                <Button onClick={() => setConfirmVoid(true)} disabled={busy === 'void'} aria-busy={busy === 'void' || undefined}>
                  {busy === 'void' ? 'Voiding…' : 'Void'}
                </Button>
              </div>
            )}

            {data.status === 'POSTED' && data.unappliedCents > 0 && (
              <div className={s.payment}>
                <span className="t-head">Apply <span className="tnum">{formatMoney(data.unappliedCents)}</span> credit</span>
                {data.linkedInvoice ? (
                  <p className="ink-2">
                    To invoice <b className="tnum">{data.linkedInvoice.invoiceNumber}</b> (open {formatMoney(data.linkedInvoice.balanceCents)}).
                  </p>
                ) : (
                  <Field label="Open invoice">
                    <Select value={applyInvoiceId} onChange={(e) => setApplyInvoiceId(e.target.value)}>
                      <option value="">Select an open invoice…</option>
                      {openInvoices.map((i) => (
                        <option key={i.id} value={i.id}>{i.invoiceNumber} · open {formatMoney(i.balanceCents)}</option>
                      ))}
                    </Select>
                  </Field>
                )}
                <div className="btn-row">
                  <Button
                    variant="primary"
                    onClick={() => act('apply', applyTarget ? { invoice_id: applyTarget } : {}, 'Credit applied to invoice')}
                    disabled={busy === 'apply' || !applyTarget}
                    aria-busy={busy === 'apply' || undefined}
                  >
                    {busy === 'apply' ? 'Applying…' : 'Apply credit'}
                  </Button>
                </div>
              </div>
            )}

            {data.status === 'POSTED' && data.glEntryId && (
              <p className="t-cap tnum" style={{ marginTop: 12 }}>GL entry {data.glEntryId}</p>
            )}
            {data.status === 'APPLIED' && (
              <InlineNotice title="Fully applied.">This credit has been used against invoice balances.</InlineNotice>
            )}
            {data.status === 'VOIDED' && (
              <InlineNotice title="Voided before posting.">No GL impact.</InlineNotice>
            )}
          </section>

          <ConfirmDialog
            open={confirmVoid}
            onClose={() => setConfirmVoid(false)}
            onConfirm={() => act('void', undefined, 'Credit memo voided')}
            title="Void this draft credit memo?"
            confirmLabel="Void credit memo"
            tone="danger"
          >
            The number is kept for audit. Nothing posts to the GL.
          </ConfirmDialog>
        </>
      )}
    </DetailDrawer>
  );
}

// ─── Create modal ─────────────────────────────────────────────────────
interface CMLine { account_id: string; description: string; amount_cents: number }

function CreateCreditMemoModal({ prefill, onClose, onCreated }: {
  prefill: CreditMemoPrefill | null; onClose: () => void; onCreated: () => void;
}) {
  const [locationId, setLocationId] = useState(prefill?.locationId ?? '');
  const [customerId, setCustomerId] = useState(prefill?.customerId ?? '');
  const [invoiceId, setInvoiceId] = useState(prefill?.invoiceId ?? '');
  const [creditDate, setCreditDate] = useState(new Date().toISOString().split('T')[0]);
  const [reason, setReason] = useState('');
  const [memo, setMemo] = useState('');
  const [taxCents, setTaxCents] = useState(0);
  const [lines, setLines] = useState<CMLine[]>([{ account_id: '', description: '', amount_cents: 0 }]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const { data: custData } = useQuery<{ data: CustomerOption[] }>('/api/customers?per_page=200');
  const { data: acctData } = useQuery<{ data: AccountOption[] }>(
    locationId ? `/api/accounts/search?location_id=${locationId}&q=4` : null,
  );
  // Open invoices for the chosen customer, to optionally link the credit.
  const { data: invData } = useQuery<{ data: { id: string; invoiceNumber: string; balanceCents: number; customer: { id: string } | null; status: string }[] }>(
    customerId ? `/api/invoices?customer_id=${customerId}` : null,
  );

  const locations = locData?.data ?? [];
  const customers = custData?.data ?? [];
  const accounts = acctData?.data ?? [];
  const linkableInvoices = (invData?.data ?? []).filter((i) => i.balanceCents > 0 && i.status !== 'DRAFT' && i.status !== 'VOIDED');

  // Esc closes through the kit Dialog (focus-trapped, modal).

  const subtotal = lines.reduce((sum, l) => sum + Math.max(0, l.amount_cents), 0);
  const total = subtotal + taxCents;

  const updateLine = (i: number, patch: Partial<CMLine>) => setLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit() {
    setFormError('');
    if (!locationId || !customerId || !creditDate) { setFormError('Company, customer, and date are required'); return; }
    if (lines.some((l) => !l.account_id || l.amount_cents <= 0)) { setFormError('Each line needs an account and a positive amount'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/credit-memos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          customer_id: customerId,
          invoice_id: invoiceId || undefined,
          credit_date: creditDate,
          reason: reason || undefined,
          memo: memo || undefined,
          tax_cents: taxCents,
          lines: lines.map((l) => ({ account_id: l.account_id, description: l.description || undefined, amount_cents: l.amount_cents })),
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { setFormError(result.error ?? 'Failed to create credit memo'); return; }
      addToast('success', `Credit memo ${result.credit_number} created`);
      onCreated();
    } catch {
      setFormError('Network error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => { if (!submitting) onClose(); }}
      title="New credit memo"
      width={760}
      className={s.tallDialog}
      dismissOnScrim={!submitting}
      footNote={<span className="tnum">Total credit {formatMoney(total)}</span>}
      actions={
        <>
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={submitting} aria-busy={submitting || undefined}>
            {submitting ? 'Creating…' : 'Create credit memo'}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        {formError && <InlineNotice tone="neg" title="Not created.">{formError}</InlineNotice>}

        <div className={s.grid2}>
          <Field label="Company *">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} data-autofocus>
              <option value="">Select company</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Customer *">
            <Select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setInvoiceId(''); }}>
              <option value="">Select customer</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>

        <div className={s.grid2}>
          <Field label="Credit date *">
            <Input type="date" value={creditDate} onChange={(e) => setCreditDate(e.target.value)} />
          </Field>
          <Field label="Apply to invoice" help={customerId ? 'Optional.' : 'Pick a customer to see their open invoices.'}>
            <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} disabled={!customerId}>
              <option value="">No linked invoice</option>
              {linkableInvoices.map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber} · open {formatMoney(i.balanceCents)}</option>)}
            </Select>
          </Field>
        </div>

        <div className={s.grid2}>
          <Field label="Reason">
            <Input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Overbilled, returned goods" />
          </Field>
          <Field label="Memo">
            <Input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Internal note" />
          </Field>
        </div>

        {/* Lines */}
        <div>
          <div className={s.linesHead}>
            <span className="eyebrow">Credit lines — revenue account to reverse</span>
            <Button variant="quiet" icon="plus" onClick={() => setLines((p) => [...p, { account_id: '', description: '', amount_cents: 0 }])}>Add line</Button>
          </div>
          <div className={s.lineRows}>
            <div className={cx(s.lineGrid, s.lineGridCredit)} aria-hidden="true">
              <span className="field-label">GL account</span>
              <span className="field-label">Description</span>
              <span className={cx('field-label', s.num)}>Amount</span>
              <span />
            </div>
            {lines.map((l, i) => (
              <div key={i} className={cx(s.lineGrid, s.lineGridCredit)}>
                <Select value={l.account_id} onChange={(e) => updateLine(i, { account_id: e.target.value })} aria-label={`Line ${i + 1} GL account`}>
                  <option value="">{locationId ? 'GL account…' : 'Pick a company first'}</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
                </Select>
                <Input type="text" value={l.description} onChange={(e) => updateLine(i, { description: e.target.value })} placeholder="Description" aria-label={`Line ${i + 1} description`} />
                <MoneyInput valueCents={l.amount_cents} onChangeCents={(c) => updateLine(i, { amount_cents: c ?? 0 })} aria-label={`Line ${i + 1} amount`} />
                {lines.length > 1 ? (
                  <Button variant="quiet" iconOnly icon="x" onClick={() => setLines((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p))} aria-label={`Remove line ${i + 1}`} />
                ) : <span />}
              </div>
            ))}
          </div>
        </div>

        {/* Totals */}
        <div className={s.totals}>
          <div className={s.totRow}><span>Subtotal</span><span>{formatMoney(subtotal)}</span></div>
          <div className={s.totRow}>
            <span>Tax to reverse</span>
            <MoneyInput className={s.taxInput} valueCents={taxCents} onChangeCents={(c) => setTaxCents(c ?? 0)} aria-label="Tax to reverse" />
          </div>
          <div className={cx(s.totRow, s.totGrand)}><span>Total credit</span><span>{formatMoney(total)}</span></div>
        </div>
      </div>
    </Dialog>
  );
}
