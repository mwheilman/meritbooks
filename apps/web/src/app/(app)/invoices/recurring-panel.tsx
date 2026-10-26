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
} from '@meritbooks/merit-ui';
import { EmptyState, TableSkeleton } from '@/components/ui';
import s from './invoices.module.css';

// ─── Types ────────────────────────────────────────────────────────────
type Frequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';

type GenerateMode = 'DRAFT' | 'POST' | 'POST_AND_SEND';

const GENERATE_MODES: { value: GenerateMode; label: string; short: string; help: string }[] = [
  { value: 'DRAFT', label: 'Create a draft for me to review', short: 'draft for review', help: 'Each invoice is created as a draft — nothing posts and nothing is emailed until you send it.' },
  { value: 'POST', label: 'Post it to AR (don\u2019t email)', short: 'post', help: 'Each invoice posts to AR; you send it yourself.' },
  { value: 'POST_AND_SEND', label: 'Post it and email the customer', short: 'post + email', help: 'Each invoice posts to AR and is emailed to the customer (if email is set up).' },
];

interface TemplateRow {
  id: string;
  name: string;
  frequency: Frequency;
  intervalCount: number;
  startDate: string;
  nextRunDate: string | null;
  endDate: string | null;
  occurrencesRemaining: number | null;
  isActive: boolean;
  autoSend: boolean;
  generateMode?: GenerateMode;
  amountCents: number;
  lineCount: number;
  lastGeneratedAt: string | null;
  isDue: boolean;
  customer: { id: string; name: string } | null;
  location: { id: string; name: string; shortCode: string } | null;
}
interface LocationOption { id: string; name: string; short_code: string }
interface CustomerOption { id: string; name: string }
interface AccountOption { id: string; account_number: string; name: string }

const FREQ_UNIT: Record<Frequency, string> = {
  WEEKLY: 'week', BIWEEKLY: 'two weeks', MONTHLY: 'month',
  QUARTERLY: 'quarter', SEMIANNUAL: 'six months', ANNUAL: 'year',
};

function cadenceLabel(freq: Frequency, interval: number): string {
  if (interval <= 1) {
    return freq === 'BIWEEKLY' ? 'Every two weeks' : freq === 'SEMIANNUAL' ? 'Every six months' : `Every ${FREQ_UNIT[freq]}`;
  }
  return `Every ${interval} ${FREQ_UNIT[freq]}${interval > 1 && !FREQ_UNIT[freq].endsWith('s') ? 's' : ''}`;
}


type Filter = 'ALL' | 'DUE' | 'ACTIVE' | 'PAUSED';

const modeOf = (t: { generateMode?: GenerateMode; autoSend: boolean }): GenerateMode =>
  t.generateMode ?? (t.autoSend ? 'POST_AND_SEND' : 'POST');

// ─── Panel ────────────────────────────────────────────────────────────
export function RecurringPanel() {
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [confirmDelete, setConfirmDelete] = useState<TemplateRow | null>(null);

  const { data, isLoading, error, refetch } = useQuery<{
    data: TemplateRow[];
    counts: { ALL: number; ACTIVE: number; PAUSED: number; DUE: number };
  }>(`/api/recurring-invoices?_k=${refreshKey}`);

  const counts = data?.counts ?? { ALL: 0, ACTIVE: 0, PAUSED: 0, DUE: 0 };
  const templates = useMemo(() => {
    const all = data?.data ?? [];
    if (filter === 'DUE') return all.filter((t) => t.isDue);
    if (filter === 'ACTIVE') return all.filter((t) => t.isActive);
    if (filter === 'PAUSED') return all.filter((t) => !t.isActive);
    return all;
  }, [data, filter]);
  const refresh = () => { setRefreshKey((k) => k + 1); setShowCreate(false); setEditId(null); };

  const modalOpen = showCreate || !!editId || !!confirmDelete;
  const { activeIndex, setActiveIndex, rowProps } = useListKeynav({
    count: templates.length,
    onOpen: (i) => { const t = templates[i]; if (t) setEditId(t.id); },
    enabled: !modalOpen,
    owner: 'Recurring schedules',
  });

  async function generateDue() {
    setGenerating(true);
    try {
      const res = await fetch('/api/recurring-invoices/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { addToast('error', result.error ?? 'Generation failed'); return; }
      const created = result.invoices_created ?? 0;
      const sent = result.invoices_sent ?? 0;
      if (created === 0) addToast('success', 'No invoices due — everything is up to date');
      else addToast('success', `Generated ${created} invoice${created === 1 ? '' : 's'}${sent > 0 ? `, sent ${sent}` : ''}`);
      if ((result.errors ?? []).length > 0) addToast('error', `${result.errors.length} template(s) had errors`);
      refresh();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setGenerating(false);
    }
  }

  async function toggleActive(t: TemplateRow) {
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/recurring-invoices/${t.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !t.isActive }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); addToast('error', e.error ?? 'Update failed'); return; }
      addToast('success', t.isActive ? 'Schedule paused' : 'Schedule resumed');
      refresh();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusyId(null);
    }
  }

  async function runOne(t: TemplateRow) {
    setBusyId(t.id);
    try {
      const res = await fetch('/api/recurring-invoices/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: t.id }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { addToast('error', result.error ?? 'Generation failed'); return; }
      const created = result.invoices_created ?? 0;
      addToast('success', created > 0 ? `Generated ${created} invoice${created === 1 ? '' : 's'}` : 'Nothing due for this schedule');
      refresh();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusyId(null);
    }
  }

  // Confirmed through the kit ConfirmDialog (was a browser confirm()).
  async function remove(t: TemplateRow) {
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/recurring-invoices/${t.id}`, { method: 'DELETE' });
      if (!res.ok) { const e = await res.json().catch(() => ({})); addToast('error', e.error ?? 'Delete failed'); return; }
      addToast('success', 'Schedule deleted');
      refresh();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className={s.sectionHead}>
        <div>
          <h2 className="t-section">Recurring invoices</h2>
          <p>Bill customers automatically on a schedule. Books creates each invoice when it&apos;s due.</p>
        </div>
        <div className="btn-row">
          <Button onClick={() => void generateDue()} disabled={generating} aria-busy={generating || undefined}>
            {generating ? 'Generating…' : 'Generate due now'}
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setShowCreate(true)}>New schedule</Button>
        </div>
      </div>

      <div className={s.toolbar}>
        <Seg<Filter>
          aria-label="Schedule status"
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'ALL', label: 'All', count: counts.ALL },
            { value: 'DUE', label: 'Due now', count: counts.DUE },
            { value: 'ACTIVE', label: 'Active', count: counts.ACTIVE },
            { value: 'PAUSED', label: 'Paused', count: counts.PAUSED },
          ]}
        />
        <span className={s.toolbarSp} />
        {counts.DUE > 0 && <span className="t-cap tnum">{counts.DUE} waiting to be generated</span>}
      </div>

      {error ? (
        <div className={cx('surface', s.state)}>
          <div className="wg-state" role="alert">
            <Tag tone="neg">Not loaded</Tag>
            <span className="t-head">Recurring schedules didn&apos;t load</span>
            <p>{error}</p>
            <Button onClick={() => void refetch()}>Try again</Button>
          </div>
        </div>
      ) : isLoading && !data ? (
        <TableSkeleton rows={5} cols={6} />
      ) : templates.length === 0 ? (
        <div className="surface">
          {filter !== 'ALL' && counts.ALL > 0 ? (
            <EmptyState
              title="No schedules in this view"
              description="Nothing matches this status. Show every schedule to see the rest."
              action={{ label: 'Show all', onClick: () => setFilter('ALL') }}
            />
          ) : (
            <EmptyState
              title="No recurring schedules"
              description="Create a schedule to bill a customer automatically each period."
              action={{ label: 'New schedule', onClick: () => setShowCreate(true) }}
            />
          )}
        </div>
      ) : (
        <>
          <div className={s.tableWrap}>
            <table className={cx('tbl', 'tbl-q', s.table)} aria-label="Recurring schedules">
              <colgroup>
                <col />
                <col style={{ width: 200 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 132 }} />
                <col style={{ width: 112 }} />
                <col style={{ width: 312 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Schedule</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Cadence</th>
                  <th scope="col">Next run</th>
                  <th scope="col" className="n">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="n"><span className="sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t, i) => (
                  <tr
                    key={t.id}
                    {...rowProps(i)}
                    onClick={() => setActiveIndex(i)}
                    onDoubleClick={() => setEditId(t.id)}
                    className={cx('q-row', i === activeIndex && 'is-cursor', t.isActive && t.isDue && 'is-attn')}
                    aria-current={i === activeIndex || undefined}
                  >
                    <td>
                      <div className={s.cellStack}>
                        <span style={{ fontWeight: 600 }}>{t.name}</span>
                        <span className="t-cap">
                          {t.location?.name ?? '—'} · {GENERATE_MODES.find((m) => m.value === modeOf(t))?.short}
                        </span>
                      </div>
                    </td>
                    <td>{t.customer?.name ?? '—'}</td>
                    <td className="ink-2">{cadenceLabel(t.frequency, t.intervalCount)}</td>
                    <td>
                      <div className={s.cellStack}>
                        <span className={s.inline}>
                          <span className="tnum">{t.nextRunDate ?? '—'}</span>
                          {t.isDue && <Tag tone="warn">Due</Tag>}
                        </span>
                        {t.occurrencesRemaining != null && <span className="t-cap tnum">{t.occurrencesRemaining} left</span>}
                      </div>
                    </td>
                    <td className="n">{formatMoney(t.amountCents)}</td>
                    <td>
                      {t.isActive ? <Status kind="ready">Active</Status> : <Status kind="track" pip="closed">Paused</Status>}
                    </td>
                    <td className="n">
                      {busyId === t.id ? (
                        <span className="t-cap" role="status">Working…</span>
                      ) : (
                        <span className="mb-row-acts">
                          {t.isActive && t.isDue && (
                            <Button variant="quiet" onClick={() => void runOne(t)} aria-label={`Generate ${t.name} now`}>Generate</Button>
                          )}
                          <Button variant="quiet" onClick={() => void toggleActive(t)} aria-label={`${t.isActive ? 'Pause' : 'Resume'} ${t.name}`}>
                            {t.isActive ? 'Pause' : 'Resume'}
                          </Button>
                          <Button variant="quiet" onClick={() => setEditId(t.id)} aria-label={`Edit ${t.name}`}>Edit</Button>
                          <Button variant="quiet" onClick={() => setConfirmDelete(t)} aria-label={`Delete ${t.name}`}>Delete</Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={s.tableFoot}>
            <Keyhints hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'edit schedule' }]} />
          </div>
        </>
      )}

      {showCreate && <TemplateModal onClose={() => setShowCreate(false)} onSaved={refresh} />}
      {editId && <TemplateModal templateId={editId} onClose={() => setEditId(null)} onSaved={refresh} />}
      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => { if (confirmDelete) await remove(confirmDelete); }}
        title={confirmDelete ? `Delete “${confirmDelete.name}”?` : 'Delete schedule?'}
        confirmLabel="Delete schedule"
        tone="danger"
      >
        Invoices already generated are unaffected. Future invoices from this schedule stop.
      </ConfirmDialog>
    </div>
  );
}

// ─── Create / edit modal ──────────────────────────────────────────────
interface TLine { description: string; account_id: string; quantity: number; unit_price_cents: number }

interface TemplateDetail {
  id: string; name: string; frequency: Frequency; intervalCount: number;
  startDate: string; nextRunDate: string | null; endDate: string | null;
  occurrencesRemaining: number | null; autoSend: boolean; generateMode?: GenerateMode; memo: string | null;
  taxCents: number; terms: number; isProgressBill: boolean;
  lines: { description: string; accountId: string; quantity: number; unitPriceCents: number }[];
  customer: { id: string; name: string } | null;
  location: { id: string; name: string; shortCode: string } | null;
}


function TemplateModal({ templateId, onClose, onSaved }: { templateId?: string; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!templateId;
  const { data: detail, error: detailError, refetch: refetchDetail } = useQuery<TemplateDetail>(templateId ? `/api/recurring-invoices/${templateId}` : '', undefined, { enabled: isEdit });

  const [name, setName] = useState('');
  const [locationId, setLocationId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('MONTHLY');
  const [intervalCount, setIntervalCount] = useState(1);
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState('');
  const [occurrences, setOccurrences] = useState('');
  const [terms, setTerms] = useState(30);
  const [generateMode, setGenerateMode] = useState<GenerateMode>('DRAFT');
  const [memo, setMemo] = useState('');
  const [taxCents, setTaxCents] = useState(0);
  const [lines, setLines] = useState<TLine[]>([{ description: '', account_id: '', quantity: 1, unit_price_cents: 0 }]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const { data: custData } = useQuery<{ data: CustomerOption[] }>('/api/customers?per_page=200');
  const { data: acctData } = useQuery<{ data: AccountOption[] }>(locationId ? `/api/accounts/search?location_id=${locationId}&q=4` : null);

  const locations = locData?.data ?? [];
  const customers = custData?.data ?? [];
  const accounts = acctData?.data ?? [];

  // Esc closes through the kit Dialog (focus-trapped, modal).

  // Hydrate the form from the loaded template when editing.
  useEffect(() => {
    if (!detail) return;
    setName(detail.name);
    setLocationId(detail.location?.id ?? '');
    setCustomerId(detail.customer?.id ?? '');
    setFrequency(detail.frequency);
    setIntervalCount(detail.intervalCount);
    setStartDate(detail.startDate);
    setEndDate(detail.endDate ?? '');
    setOccurrences(detail.occurrencesRemaining != null ? String(detail.occurrencesRemaining) : '');
    setTerms(detail.terms);
    setGenerateMode(detail.generateMode ?? (detail.autoSend ? 'POST_AND_SEND' : 'POST'));
    setMemo(detail.memo ?? '');
    setTaxCents(detail.taxCents);
    setLines(detail.lines.length ? detail.lines.map((l) => ({ description: l.description, account_id: l.accountId, quantity: l.quantity, unit_price_cents: l.unitPriceCents })) : [{ description: '', account_id: '', quantity: 1, unit_price_cents: 0 }]);
  }, [detail]);

  const subtotal = lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unit_price_cents), 0);
  const total = subtotal + taxCents;

  const updateLine = (i: number, patch: Partial<TLine>) => setLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit() {
    setFormError('');
    if (!name || !locationId || !customerId || !startDate) { setFormError('Name, company, customer, and start date are required'); return; }
    if (lines.some((l) => !l.description || !l.account_id)) { setFormError('Each line needs a description and a GL account'); return; }
    if (endDate && endDate < startDate) { setFormError('End date cannot precede start date'); return; }

    setSubmitting(true);
    try {
      const linePayload = lines.map((l) => ({ description: l.description, account_id: l.account_id, quantity: l.quantity, unit_price_cents: l.unit_price_cents }));
      let res: Response;
      if (isEdit) {
        res = await fetch(`/api/recurring-invoices/${templateId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name, frequency, interval_count: intervalCount,
            end_date: endDate || null,
            occurrences_remaining: occurrences ? parseInt(occurrences, 10) : null,
            generate_mode: generateMode, memo: memo || null, tax_cents: taxCents, terms, lines: linePayload,
          }),
        });
      } else {
        res = await fetch('/api/recurring-invoices', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name, location_id: locationId, customer_id: customerId, frequency, interval_count: intervalCount,
            start_date: startDate, end_date: endDate || undefined,
            occurrences: occurrences ? parseInt(occurrences, 10) : undefined,
            generate_mode: generateMode, memo: memo || undefined, tax_cents: taxCents, terms, lines: linePayload,
          }),
        });
      }
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { setFormError(result.error ?? 'Failed to save schedule'); return; }
      addToast('success', isEdit ? 'Schedule updated' : 'Recurring schedule created');
      onSaved();
    } catch {
      setFormError('Network error');
    } finally {
      setSubmitting(false);
    }
  }

  const loadingDetail = isEdit && !detail && !detailError;

  return (
    <Dialog
      open
      onClose={() => { if (!submitting) onClose(); }}
      title={isEdit ? 'Edit recurring schedule' : 'New recurring schedule'}
      width={820}
      className={s.tallDialog}
      dismissOnScrim={!submitting}
      footNote={<span className="tnum">Per invoice {formatMoney(total)}</span>}
      actions={
        <>
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={submitting || loadingDetail || !!detailError} aria-busy={submitting || undefined}>
            {submitting ? 'Saving…' : isEdit ? 'Save schedule' : 'Create schedule'}
          </Button>
        </>
      }
    >
      {detailError ? (
        <InlineNotice tone="neg" title="Couldn't load this schedule.">
          {detailError} <Button variant="quiet" onClick={() => void refetchDetail()}>Try again</Button>
        </InlineNotice>
      ) : loadingDetail ? (
        <div className="wg-loading" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0' }} aria-busy="true">
          <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '80%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '50%' }} aria-hidden="true" />
          <span className="t-cap" role="status">Loading the schedule…</span>
        </div>
      ) : (
        <div className={s.form}>
          {formError && <InlineNotice tone="neg" title="Not saved.">{formError}</InlineNotice>}

          <div className={s.grid2}>
            <Field label="Schedule name *">
              <Input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly retainer — Acme" data-autofocus />
            </Field>
            <Field label="Company *" help={isEdit ? 'Fixed once the schedule exists.' : undefined}>
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={isEdit}>
                <option value="">Select company</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
          </div>

          <div className={s.grid2}>
            <Field label="Customer *">
              <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={isEdit}>
                <option value="">Select customer</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <div className={s.grid2}>
              <Field label="Frequency *">
                <Select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
                  <option value="WEEKLY">Weekly</option>
                  <option value="BIWEEKLY">Biweekly</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="SEMIANNUAL">Semiannual</option>
                  <option value="ANNUAL">Annual</option>
                </Select>
              </Field>
              <Field label="Every">
                <Input type="number" min={1} max={52} value={intervalCount} className={s.num} onChange={(e) => setIntervalCount(Math.max(1, parseInt(e.target.value, 10) || 1))} />
              </Field>
            </div>
          </div>

          <div className={s.grid4}>
            <Field label="Start date *">
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={isEdit} />
            </Field>
            <Field label="End date">
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </Field>
            <Field label="Occurrences" help="Blank = no limit">
              <Input type="number" min={1} value={occurrences} onChange={(e) => setOccurrences(e.target.value)} placeholder="∞" className={s.num} />
            </Field>
            <Field label="Net terms (days)">
              <Input type="number" min={0} value={terms} className={s.num} onChange={(e) => setTerms(Math.max(0, parseInt(e.target.value, 10) || 0))} />
            </Field>
          </div>

          {/* Line items */}
          <div>
            <div className={s.linesHead}>
              <span className="eyebrow">Lines</span>
              <Button variant="quiet" icon="plus" onClick={() => setLines((p) => [...p, { description: '', account_id: '', quantity: 1, unit_price_cents: 0 }])}>Add line</Button>
            </div>
            <div className={s.lineRows}>
              <div className={s.lineGrid} aria-hidden="true">
                <span className="field-label">Description</span>
                <span className="field-label">GL account</span>
                <span className={cx('field-label', s.num)}>Qty</span>
                <span className={cx('field-label', s.num)}>Unit price</span>
                <span className={cx('field-label', s.num)}>Amount</span>
                <span />
              </div>
              {lines.map((l, i) => (
                <div key={i} className={s.lineGrid}>
                  <Input type="text" value={l.description} onChange={(e) => updateLine(i, { description: e.target.value })} placeholder="Description" aria-label={`Line ${i + 1} description`} />
                  <Select value={l.account_id} onChange={(e) => updateLine(i, { account_id: e.target.value })} aria-label={`Line ${i + 1} GL account`}>
                    <option value="">{locationId ? 'GL account…' : 'Pick a company first'}</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
                  </Select>
                  <Input type="number" min={0} step={0.01} value={l.quantity} className={s.num} onChange={(e) => updateLine(i, { quantity: parseFloat(e.target.value) || 0 })} aria-label={`Line ${i + 1} quantity`} />
                  <MoneyInput valueCents={l.unit_price_cents} onChangeCents={(c) => updateLine(i, { unit_price_cents: c ?? 0 })} aria-label={`Line ${i + 1} unit price`} />
                  <span className={s.amount}>{formatMoney(Math.round(l.quantity * l.unit_price_cents))}</span>
                  {lines.length > 1 ? (
                    <Button variant="quiet" iconOnly icon="x" onClick={() => setLines((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p))} aria-label={`Remove line ${i + 1}`} />
                  ) : <span />}
                </div>
              ))}
            </div>
          </div>

          {/* Memo + generate mode · totals */}
          <div className={s.grid2}>
            <div className={s.form}>
              <Field label="Memo" help="Prints on each invoice.">
                <Input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
              </Field>
              <Field
                label="When an invoice comes due"
                help={`${GENERATE_MODES.find((m) => m.value === generateMode)?.help ?? ''} The nightly run only posts or emails when Settings → Autonomy → Scheduled recurring invoices allows it; otherwise it drafts.`}
              >
                <Select id="recurring-generate-mode" value={generateMode} onChange={(e) => setGenerateMode(e.target.value as GenerateMode)}>
                  {GENERATE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
              </Field>
            </div>
            <div className={s.totals} style={{ alignSelf: 'end' }}>
              <div className={s.totRow}><span>Subtotal</span><span>{formatMoney(subtotal)}</span></div>
              <div className={s.totRow}>
                <span>Tax</span>
                <MoneyInput className={s.taxInput} valueCents={taxCents} onChangeCents={(c) => setTaxCents(c ?? 0)} aria-label="Tax amount" />
              </div>
              <div className={cx(s.totRow, s.totGrand)}><span>Per invoice</span><span>{formatMoney(total)}</span></div>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
