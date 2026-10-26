'use client';

import { useMemo, useState } from 'react';
import { Button, ConfirmDialog, Drawer, Field, Input, MoneyInput, Select, Switch, Tag, Textarea, toast, useQuery } from '@meritbooks/merit-ui';
import { CATEGORY_LABEL } from '@/lib/cash/forecast/types';
import { dayLabel, usd, type Category, type ManualItem, type ScenarioRow } from './cash-types';
import s from './cash.module.css';

const IN_CATS: Category[] = ['DEPOSIT', 'OTHER_IN', 'TRANSFER_IN', 'LINE_DRAW'];
const OUT_CATS: Category[] = ['CAPEX', 'OPEX', 'TAX', 'DISTRIBUTION', 'TRANSFER_OUT', 'LINE_PAYDOWN', 'OTHER_OUT'];
const RECUR_WORD: Record<ManualItem['recurrence'], string> = { NONE: 'One-off', WEEKLY: 'Weekly', BIWEEKLY: 'Every 2 weeks', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly' };

interface Draft {
  id: string | null;
  location_id: string;
  scenario_id: string;
  direction: 'IN' | 'OUT';
  category: Category;
  label: string;
  expected_date: string;
  amount_cents: number | null;
  probability: string;
  recurrence: ManualItem['recurrence'];
  recurrence_end: string;
  counterparty_location_id: string;
  note: string;
  is_active: boolean;
}

function blank(locationId: string): Draft {
  return { id: null, location_id: locationId, scenario_id: '', direction: 'OUT', category: 'CAPEX', label: '', expected_date: '', amount_cents: null, probability: '100', recurrence: 'NONE', recurrence_end: '', counterparty_location_id: '', note: '', is_active: true };
}

/**
 * Manual forecast lines (deposits, capex, distributions, transfers, line draws …) with a note —
 * migration 192 cash_forecast_items. Scenario-specific items show only in that scenario.
 */
export function ItemsPanel({
  locationId,
  companies,
  scenarios,
  refreshKey,
  onChanged,
}: {
  locationId: string | null;
  companies: Array<{ id: string; name: string }>;
  scenarios: ScenarioRow[];
  refreshKey: number;
  onChanged: () => void;
}) {
  const q = useQuery<{ items: ManualItem[]; today: string }>('/api/cash/items', { location_id: locationId ?? 'all' }, { key: `items:${refreshKey}`, scope: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<ManualItem | null>(null);
  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);
  const scenarioName = useMemo(() => new Map(scenarios.map((x) => [x.id, x.name])), [scenarios]);

  const open = (it?: ManualItem) => {
    setErrors({});
    if (!it) {
      setDraft(blank(locationId ?? companies[0]?.id ?? ''));
      return;
    }
    setDraft({
      id: it.id,
      location_id: it.companyId,
      scenario_id: it.scenarioId ?? '',
      direction: it.direction,
      category: it.category,
      label: it.label,
      expected_date: it.expectedDate,
      amount_cents: it.amountCents,
      probability: String(it.probabilityBps / 100),
      recurrence: it.recurrence,
      recurrence_end: it.recurrenceEnd ?? '',
      counterparty_location_id: it.counterpartyCompanyId ?? '',
      note: it.note ?? '',
      is_active: it.isActive,
    });
  };

  const save = async () => {
    if (!draft) return;
    const e: Record<string, string> = {};
    if (!draft.location_id) e.location_id = 'Pick the company';
    if (!draft.label.trim()) e.label = 'Describe the item';
    if (!draft.expected_date) e.expected_date = 'Pick a date';
    if (!draft.amount_cents || draft.amount_cents <= 0) e.amount_cents = 'Enter an amount above zero';
    const p = Number(draft.probability);
    if (!(p > 0 && p <= 100)) e.probability = 'Between 1 and 100';
    if ((draft.category === 'TRANSFER_IN' || draft.category === 'TRANSFER_OUT') && !draft.counterparty_location_id) e.counterparty_location_id = 'Pick the other company';
    if (draft.recurrence !== 'NONE' && draft.recurrence_end && draft.recurrence_end < draft.expected_date) e.recurrence_end = 'Ends before it starts';
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const body = {
        ...(draft.id ? { id: draft.id, is_active: draft.is_active } : {}),
        location_id: draft.location_id,
        scenario_id: draft.scenario_id || null,
        direction: draft.direction,
        category: draft.category,
        label: draft.label.trim(),
        expected_date: draft.expected_date,
        amount_cents: draft.amount_cents,
        probability_bps: Math.round(p * 100),
        recurrence: draft.recurrence,
        recurrence_end: draft.recurrence === 'NONE' ? null : draft.recurrence_end || null,
        counterparty_location_id: draft.counterparty_location_id || null,
        note: draft.note.trim() || null,
      };
      const res = await fetch('/api/cash/items', { method: draft.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
      const json = (await res.json().catch(() => ({}))) as { error?: string; details?: Record<string, string[]> };
      if (!res.ok) {
        if (json.details) setErrors(Object.fromEntries(Object.entries(json.details).map(([k, v]) => [k, v[0] ?? 'Invalid'])));
        throw new Error(json.error ?? `Failed (${res.status})`);
      }
      toast(draft.id ? 'Item saved.' : 'Item added to the forecast.');
      setDraft(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (it: ManualItem) => {
    const res = await fetch(`/api/cash/items?id=${encodeURIComponent(it.id)}`, { method: 'DELETE', credentials: 'same-origin' });
    if (!res.ok) {
      toast.error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not remove the item');
      return;
    }
    toast(`Removed “${it.label}”.`);
    onChanged();
  };

  const items = q.data?.items ?? [];
  const cats = draft?.direction === 'IN' ? IN_CATS : OUT_CATS;

  return (
    <section>
      <div className="row row--between">
        <h2 className={`t-section ${s.section}`}>04 // Manual items</h2>
        <Button variant="primary" icon="plus" disabled={companies.length === 0} onClick={() => open()}>
          Add item
        </Button>
      </div>
      <p className="t-cap" style={{ marginBottom: 8 }}>
        Cash the books can&rsquo;t see yet: a customer deposit you&rsquo;re promised, a truck you&rsquo;ll buy, an owner distribution, a transfer between companies, a line draw. Each carries a note so the next person knows why.
      </p>
      {q.isLoading ? (
        <p className="t-cap" role="status">Loading items…</p>
      ) : q.error ? (
        <div className={s.state} role="alert">
          <p className="t-head">Couldn’t load the items.</p>
          <p className="t-cap">{q.error}</p>
          <Button onClick={() => void q.refetch()}>Try again</Button>
        </div>
      ) : items.length === 0 ? (
        <div className={s.state}>
          <p className="t-head">No manual items.</p>
          <p className="t-cap">The forecast is built entirely from what&rsquo;s on file. Add one when you know something the books don&rsquo;t.</p>
        </div>
      ) : (
        <div className={s.tableWrap}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Item</th>
                <th>Company</th>
                <th>When</th>
                <th>Scenario</th>
                <th className="n">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className={it.isActive ? '' : s.muted}>
                  <td>
                    <span className="l1">
                      {it.label} {!it.isActive && <Tag>Paused</Tag>}
                    </span>
                    <span className="l2">
                      {CATEGORY_LABEL[it.category]}
                      {it.probabilityBps < 10_000 ? ` · ${it.probabilityBps / 100}% likely` : ''}
                      {it.counterpartyCompanyId ? ` · with ${companyName.get(it.counterpartyCompanyId) ?? 'another company'}` : ''}
                      {it.note ? ` · ${it.note}` : ''}
                    </span>
                  </td>
                  <td>{companyName.get(it.companyId) ?? '—'}</td>
                  <td>
                    {dayLabel(it.expectedDate)}
                    <span className="l2">
                      {RECUR_WORD[it.recurrence]}
                      {it.recurrenceEnd ? ` until ${dayLabel(it.recurrenceEnd)}` : ''}
                    </span>
                  </td>
                  <td>{it.scenarioId ? (scenarioName.get(it.scenarioId) ?? 'Archived scenario') : 'Every scenario'}</td>
                  <td className={`n tnum ${it.direction === 'IN' ? s.pos : ''}`}>
                    {it.direction === 'IN' ? '+' : '−'}
                    {usd(it.amountCents)}
                  </td>
                  <td className="n">
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <Button variant="quiet" onClick={() => open(it)}>
                        Edit
                      </Button>
                      <Button variant="quiet" icon="x" aria-label={`Remove ${it.label}`} onClick={() => setDeleting(it)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={draft !== null}
        onClose={() => setDraft(null)}
        eyebrow={['Cash forecast', 'Manual item']}
        title={draft?.id ? 'Edit item' : 'Add an item'}
        foot={
          <div className="row">
            <Button variant="quiet" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <span className="sp" />
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : draft?.id ? 'Save item' : 'Add to forecast'}
            </Button>
          </div>
        }
      >
        {draft && (
          <div className="stack">
            <Field label="Company" error={errors.location_id}>
              <Select value={draft.location_id} disabled={!!draft.id} onChange={(e) => setDraft({ ...draft, location_id: e.target.value })}>
                <option value="">Pick a company…</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Cash">
              <Select
                value={draft.direction}
                onChange={(e) => {
                  const d = e.target.value as 'IN' | 'OUT';
                  setDraft({ ...draft, direction: d, category: d === 'IN' ? 'DEPOSIT' : 'CAPEX' });
                }}
              >
                <option value="IN">Coming in</option>
                <option value="OUT">Going out</option>
              </Select>
            </Field>
            <Field label="Kind" error={errors.category}>
              <Select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })}>
                {cats.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
            {(draft.category === 'TRANSFER_IN' || draft.category === 'TRANSFER_OUT') && (
              <Field label={draft.category === 'TRANSFER_IN' ? 'From company' : 'To company'} error={errors.counterparty_location_id} help="Transfers between your companies are left out of the all-companies view.">
                <Select value={draft.counterparty_location_id} onChange={(e) => setDraft({ ...draft, counterparty_location_id: e.target.value })}>
                  <option value="">Pick a company…</option>
                  {companies
                    .filter((c) => c.id !== draft.location_id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
              </Field>
            )}
            <Field label="Description" error={errors.label}>
              <Input value={draft.label} maxLength={120} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Service truck purchase" />
            </Field>
            <Field label="Amount" error={errors.amount_cents}>
              <MoneyInput valueCents={draft.amount_cents} onChangeCents={(c) => setDraft({ ...draft, amount_cents: c })} />
            </Field>
            <Field label="Expected date" error={errors.expected_date}>
              <Input type="date" value={draft.expected_date} onChange={(e) => setDraft({ ...draft, expected_date: e.target.value })} />
            </Field>
            <Field label="Likelihood (%)" error={errors.probability} help="Counted at this share — 100% for a sure thing.">
              <Input type="number" inputMode="numeric" min={1} max={100} value={draft.probability} onChange={(e) => setDraft({ ...draft, probability: e.target.value })} />
            </Field>
            <Field label="Repeats">
              <Select value={draft.recurrence} onChange={(e) => setDraft({ ...draft, recurrence: e.target.value as ManualItem['recurrence'] })}>
                {(Object.keys(RECUR_WORD) as ManualItem['recurrence'][]).map((r) => (
                  <option key={r} value={r}>
                    {RECUR_WORD[r]}
                  </option>
                ))}
              </Select>
            </Field>
            {draft.recurrence !== 'NONE' && (
              <Field label="Until (optional)" error={errors.recurrence_end}>
                <Input type="date" value={draft.recurrence_end} onChange={(e) => setDraft({ ...draft, recurrence_end: e.target.value })} />
              </Field>
            )}
            <Field label="Scenario" help="Every scenario, or only one (e.g. a downside-only paydown).">
              <Select value={draft.scenario_id} onChange={(e) => setDraft({ ...draft, scenario_id: e.target.value })}>
                <option value="">Every scenario</option>
                {scenarios.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Note">
              <Textarea rows={3} maxLength={2000} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Who told you, and how sure it is" />
            </Field>
            {draft.id && <Switch checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} label="Included in the forecast" />}
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Remove “${deleting?.label ?? ''}”?`}
        confirmLabel="Remove item"
        tone="danger"
        onConfirm={async () => {
          const it = deleting;
          setDeleting(null);
          if (it) await remove(it);
        }}
      >
        It leaves every scenario. The change is kept in the cash audit log.
      </ConfirmDialog>
    </section>
  );
}
