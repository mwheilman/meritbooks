'use client';

import { useMemo, useState } from 'react';
import { Button, Check, ConfirmDialog, Field, Input, InlineNotice, MoneyInput, Select, Tag, Textarea, toast, useMutation } from '@meritbooks/merit-ui';
import { ItemsPanel } from './items-panel';
import { usd, type ForecastResponse, type ScenarioRow } from './cash-types';
import s from './cash.module.css';

type Kind = ScenarioRow['kind'];
type LeverKind = ScenarioRow['adjustments'][number]['kind'];

const KIND_WORD: Record<Kind, string> = { BASE: 'Base adjustments', DOWNSIDE: 'Downside', UPSIDE: 'Upside', CUSTOM: 'Custom' };
const LEVER_WORD: Record<LeverKind, string> = {
  DELAY_RECEIPTS: 'Customers pay later / sooner',
  RECEIPT_HAIRCUT: 'Some receipts don’t arrive',
  DELAY_DISBURSEMENTS: 'Pay vendors later / sooner',
  REMOVE_ITEM: 'Remove one item',
  PAYROLL_GROWTH: 'Payroll grows / shrinks',
  LINE_DRAW: 'Draw on a line',
  LINE_PAYDOWN: 'Pay down a line',
};

function leverText(a: ScenarioRow['adjustments'][number], names: Map<string, string>): string {
  const who = (id: string | null | undefined, all: string) => (id ? (names.get(id) ?? 'one counterparty') : all);
  switch (a.kind) {
    case 'DELAY_RECEIPTS':
      return `${who(a.customerId, 'All customers')} pay ${Math.abs(a.days ?? 0)} days ${(a.days ?? 0) > 0 ? 'later' : 'sooner'}`;
    case 'DELAY_DISBURSEMENTS':
      return `${who(a.vendorId, 'All vendors')} paid ${Math.abs(a.days ?? 0)} days ${(a.days ?? 0) > 0 ? 'later' : 'sooner'}`;
    case 'RECEIPT_HAIRCUT':
      return `${((a.bps ?? 0) / 100).toFixed(1)}% of ${who(a.customerId, 'all customers’')} receipts don’t arrive`;
    case 'PAYROLL_GROWTH':
      return `Projected payroll ${(a.bps ?? 0) > 0 ? '+' : ''}${((a.bps ?? 0) / 100).toFixed(1)}%`;
    case 'REMOVE_ITEM':
      return `Remove ${a.label ?? a.itemKey ?? 'an item'}`;
    case 'LINE_DRAW':
      return `Draw ${usd(a.amountCents ?? 0)} on ${a.effectiveDate ?? ''}`;
    case 'LINE_PAYDOWN':
      return `Pay down ${usd(a.amountCents ?? 0)} on ${a.effectiveDate ?? ''}`;
  }
}

export function ScenariosTab({
  locationId,
  companies,
  scenarios,
  selectedId,
  onSelect,
  refreshKey,
  onChanged,
  forecast,
}: {
  locationId: string | null;
  companies: Array<{ id: string; name: string }>;
  scenarios: ScenarioRow[] | null;
  selectedId: string;
  onSelect: (id: string) => void;
  refreshKey: number;
  onChanged: () => void;
  forecast: ForecastResponse | null;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('DOWNSIDE');
  const [company, setCompany] = useState<string>(locationId ?? '');
  const [presets, setPresets] = useState(true);
  const create = useMutation<{ name: string; kind: Kind; location_id: string | null; with_presets: boolean }, { id: string; presets: number }>('/api/cash/scenarios', 'post');
  const patch = useMutation<{ id: string; name?: string; description?: string | null; is_archived?: boolean }, { ok: true }>('/api/cash/scenarios', 'patch');
  const [archiveOpen, setArchiveOpen] = useState(false);

  const list = (scenarios ?? []).filter((x) => showArchived || !x.isArchived);
  const selected = (scenarios ?? []).find((x) => x.id === selectedId) ?? null;
  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);

  const onCreate = async () => {
    if (!name.trim()) {
      toast.error('Name the scenario first.');
      return;
    }
    const r = await create.mutate({ name: name.trim(), kind, location_id: company || null, with_presets: presets });
    if (r) {
      toast(`Created “${name.trim()}”${r.presets ? ` with ${r.presets} preset lever${r.presets === 1 ? '' : 's'}` : ''}.`);
      setName('');
      onChanged();
      onSelect(r.id);
    } else if (create.error) toast.error(create.error);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div className={s.grid2}>
        <section>
          <h2 className={`t-section ${s.section}`}>01 // Scenarios</h2>
          {scenarios === null ? (
            <p className="t-cap" role="status">Loading scenarios…</p>
          ) : (
            <div className={`${s.list} ${s.tableWrap}`}>
              <div className={`${s.listRow} ${selectedId === 'base' ? s.selected : ''}`}>
                <div className={s.grow}>
                  <span className="l1">Base forecast</span>
                  <span className="l2">Everything on file, as scheduled{(scenarios ?? []).some((x) => x.kind === 'BASE') ? ' + base adjustments' : ''}</span>
                </div>
                <Button variant={selectedId === 'base' ? 'primary' : 'quiet'} onClick={() => onSelect('base')}>
                  {selectedId === 'base' ? 'Showing' : 'Show'}
                </Button>
              </div>
              {list.map((x) => (
                <div key={x.id} className={`${s.listRow} ${selectedId === x.id ? s.selected : ''}`}>
                  <div className={s.grow}>
                    <span className="l1">
                      {x.name} {x.isArchived && <Tag>Archived</Tag>}
                    </span>
                    <span className="l2">
                      {KIND_WORD[x.kind]} · {x.companyId ? (companyName.get(x.companyId) ?? 'one company') : 'All companies'} · {x.adjustments.length} lever{x.adjustments.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <Button variant={selectedId === x.id ? 'primary' : 'quiet'} disabled={x.isArchived} onClick={() => onSelect(x.id)}>
                    {selectedId === x.id ? 'Showing' : 'Show'}
                  </Button>
                </div>
              ))}
              {list.length === 0 && (
                <div className={s.listRow}>
                  <span className="t-cap">No saved scenarios yet. A downside case is the one lenders ask for first.</span>
                </div>
              )}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <Check checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} label="Show archived" />
          </div>

          <h2 className={`t-section ${s.section}`}>02 // New scenario</h2>
          <div className={s.form}>
            <Field label="Name">
              <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Slow collections Q1" />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="DOWNSIDE">Downside</option>
                <option value="UPSIDE">Upside</option>
                <option value="CUSTOM">Custom</option>
                <option value="BASE">Base adjustments (apply to every scenario)</option>
              </Select>
            </Field>
            <Field label="Company">
              <Select value={company} onChange={(e) => setCompany(e.target.value)}>
                <option value="">All companies</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Starting levers" help={kind === 'DOWNSIDE' ? 'Receipts 14 days later and 10% lower, payroll +3%' : kind === 'UPSIDE' ? 'Receipts 7 days sooner' : 'Starts empty'}>
              <Check checked={presets} disabled={kind === 'CUSTOM' || kind === 'BASE'} onChange={(e) => setPresets(e.target.checked)} label="Use the preset" />
            </Field>
            <div>
              <Button variant="primary" icon="plus" disabled={create.isLoading} onClick={() => void onCreate()}>
                {create.isLoading ? 'Creating…' : 'Create scenario'}
              </Button>
            </div>
          </div>
        </section>

        <section>
          {selected ? (
            <ScenarioDetail
              key={selected.id}
              scenario={selected}
              companyName={companyName}
              forecast={forecast}
              onChanged={onChanged}
              onArchive={() => setArchiveOpen(true)}
              onRestore={async () => {
                const r = await patch.mutate({ id: selected.id, is_archived: false });
                if (r) {
                  toast(`Restored “${selected.name}”.`);
                  onChanged();
                } else if (patch.error) toast.error(patch.error);
              }}
              onRename={async (nm, desc) => {
                const r = await patch.mutate({ id: selected.id, name: nm, description: desc });
                if (r) {
                  toast('Saved.');
                  onChanged();
                } else if (patch.error) toast.error(patch.error);
              }}
            />
          ) : (
            <div className={s.state}>
              <p className="t-head">The base forecast has no levers.</p>
              <p className="t-cap">Create or pick a scenario to delay receipts, cut collections, grow payroll, remove an item or draw on a line. Manual items below apply to every scenario unless you tie them to one.</p>
            </div>
          )}
        </section>
      </div>

      <ItemsPanel locationId={locationId} companies={companies} scenarios={(scenarios ?? []).filter((x) => !x.isArchived)} refreshKey={refreshKey} onChanged={onChanged} />

      <ConfirmDialog
        open={archiveOpen && !!selected}
        onClose={() => setArchiveOpen(false)}
        title={`Archive “${selected?.name ?? ''}”?`}
        confirmLabel="Archive scenario"
        tone="danger"
        onConfirm={async () => {
          if (!selected) return;
          const r = await patch.mutate({ id: selected.id, is_archived: true });
          setArchiveOpen(false);
          if (r) {
            toast(`Archived “${selected.name}”. You can restore it from “Show archived”.`);
            onSelect('base');
            onChanged();
          } else if (patch.error) toast.error(patch.error);
        }}
      >
        It leaves the scenario switcher; its levers are kept and it can be restored.
      </ConfirmDialog>
    </div>
  );
}

interface LeverDraft {
  kind: LeverKind;
  location_id: string;
  party: string;
  days: string;
  pct: string;
  amount: number | null;
  date: string;
  item_key: string;
  note: string;
}

function ScenarioDetail({
  scenario,
  companyName,
  forecast,
  onChanged,
  onArchive,
  onRestore,
  onRename,
}: {
  scenario: ScenarioRow;
  companyName: Map<string, string>;
  forecast: ForecastResponse | null;
  onChanged: () => void;
  onArchive: () => void;
  onRestore: () => Promise<void>;
  onRename: (name: string, description: string | null) => Promise<void>;
}) {
  const [name, setName] = useState(scenario.name);
  const [desc, setDesc] = useState(scenario.description ?? '');
  const [draft, setDraft] = useState<LeverDraft>({ kind: 'DELAY_RECEIPTS', location_id: scenario.companyId ?? '', party: '', days: '14', pct: '10', amount: null, date: '', item_key: '', note: '' });
  const add = useMutation<Record<string, unknown>, { id: string }>('/api/cash/scenarios/adjustments', 'post');
  const [removing, setRemoving] = useState<string | null>(null);

  const items = forecast?.forecast.items ?? [];
  const customers = useMemo(() => uniqParties(items.filter((i) => i.category === 'AR' || i.category === 'RECURRING_AR')), [items]);
  const vendors = useMemo(() => uniqParties(items.filter((i) => i.category === 'AP')), [items]);
  const removable = useMemo(() => [...items].sort((a, b) => b.amountCents - a.amountCents).slice(0, 60), [items]);
  const partyNames = useMemo(() => new Map([...customers, ...vendors].map((p) => [p.id, p.name])), [customers, vendors]);

  const submit = async () => {
    const body: Record<string, unknown> = { scenario_id: scenario.id, kind: draft.kind, location_id: draft.location_id || null, note: draft.note || null };
    if (draft.kind === 'DELAY_RECEIPTS' || draft.kind === 'DELAY_DISBURSEMENTS') {
      body.days = Math.trunc(Number(draft.days));
      if (draft.party) body[draft.kind === 'DELAY_RECEIPTS' ? 'customer_id' : 'vendor_id'] = draft.party;
    } else if (draft.kind === 'RECEIPT_HAIRCUT' || draft.kind === 'PAYROLL_GROWTH') {
      body.bps = Math.round(Number(draft.pct) * 100);
      if (draft.kind === 'RECEIPT_HAIRCUT' && draft.party) body.customer_id = draft.party;
    } else if (draft.kind === 'REMOVE_ITEM') {
      body.item_key = draft.item_key;
      body.label = removable.find((i) => i.key === draft.item_key)?.label ?? null;
    } else {
      body.amount_cents = draft.amount;
      body.effective_date = draft.date || null;
      body.label = draft.kind === 'LINE_DRAW' ? 'Line draw' : 'Line paydown';
    }
    const r = await add.mutate(body);
    if (r) {
      toast('Lever added — the forecast is recalculating.');
      onChanged();
    } else if (add.error) toast.error(add.error);
  };

  const remove = async (id: string) => {
    setRemoving(id);
    try {
      const res = await fetch(`/api/cash/scenarios/adjustments?id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Failed (${res.status})`);
      toast('Lever removed.');
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(null);
    }
  };

  const touched = forecast?.scenario.id === scenario.id ? forecast.scenario.touched : {};
  return (
    <div>
      <h2 className={`t-section ${s.section}`}>03 // {scenario.name}</h2>
      {scenario.isArchived && (
        <InlineNotice tone="warn" title="Archived">
          <Button onClick={() => void onRestore()}>Restore</Button>
        </InlineNotice>
      )}
      <div className={s.form}>
        <Field label="Name">
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={scenario.isArchived} />
        </Field>
        <Field label="Description" className={s.formWide}>
          <Textarea value={desc} maxLength={1000} rows={2} onChange={(e) => setDesc(e.target.value)} disabled={scenario.isArchived} />
        </Field>
        <div className="row">
          <Button disabled={scenario.isArchived || !name.trim()} onClick={() => void onRename(name.trim(), desc.trim() || null)}>
            Save
          </Button>
          {!scenario.isArchived && (
            <Button variant="danger" onClick={onArchive}>
              Archive
            </Button>
          )}
        </div>
      </div>

      <h3 className="t-head" style={{ margin: '16px 0 8px' }}>
        Levers
      </h3>
      {scenario.adjustments.length === 0 ? (
        <p className="t-cap">No levers yet — this scenario equals the base forecast.</p>
      ) : (
        <div className={`${s.list} ${s.tableWrap}`}>
          {scenario.adjustments.map((a) => (
            <div key={a.id} className={s.listRow}>
              <div className={s.grow}>
                <span className="l1">{leverText(a, partyNames)}</span>
                <span className="l2">
                  {LEVER_WORD[a.kind]} · {a.companyId ? (companyName.get(a.companyId) ?? 'one company') : 'all companies'}
                  {touched[a.id] !== undefined ? ` · affects ${touched[a.id]} item${touched[a.id] === 1 ? '' : 's'}` : ''}
                  {a.note ? ` · ${a.note}` : ''}
                </span>
              </div>
              <Button variant="quiet" icon="x" disabled={removing === a.id || scenario.isArchived} onClick={() => void remove(a.id)} aria-label={`Remove lever: ${leverText(a, partyNames)}`}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      {!scenario.isArchived && (
        <>
          <h3 className="t-head" style={{ margin: '16px 0 8px' }}>
            Add a lever
          </h3>
          <div className={s.form}>
            <Field label="Lever">
              <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as LeverKind, party: '' })}>
                {(Object.keys(LEVER_WORD) as LeverKind[]).map((k) => (
                  <option key={k} value={k}>
                    {LEVER_WORD[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Company" help={scenario.companyId ? 'This scenario is for one company' : undefined}>
              <Select value={draft.location_id} disabled={!!scenario.companyId} onChange={(e) => setDraft({ ...draft, location_id: e.target.value })}>
                {!scenario.companyId && <option value="">All companies</option>}
                {Array.from(companyName.entries()).map(([id, nm]) => (
                  <option key={id} value={id}>
                    {nm}
                  </option>
                ))}
              </Select>
            </Field>
            {(draft.kind === 'DELAY_RECEIPTS' || draft.kind === 'RECEIPT_HAIRCUT' || draft.kind === 'DELAY_DISBURSEMENTS') && (
              <Field label={draft.kind === 'DELAY_DISBURSEMENTS' ? 'Vendor' : 'Customer'}>
                <Select value={draft.party} onChange={(e) => setDraft({ ...draft, party: e.target.value })}>
                  <option value="">{draft.kind === 'DELAY_DISBURSEMENTS' ? 'All vendors' : 'All customers'}</option>
                  {(draft.kind === 'DELAY_DISBURSEMENTS' ? vendors : customers).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({usd(p.cents)})
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {(draft.kind === 'DELAY_RECEIPTS' || draft.kind === 'DELAY_DISBURSEMENTS') && (
              <Field label="Days (negative = sooner)">
                <Input type="number" inputMode="numeric" min={-90} max={180} value={draft.days} onChange={(e) => setDraft({ ...draft, days: e.target.value })} />
              </Field>
            )}
            {(draft.kind === 'RECEIPT_HAIRCUT' || draft.kind === 'PAYROLL_GROWTH') && (
              <Field label={draft.kind === 'RECEIPT_HAIRCUT' ? 'Cut (%)' : 'Change (%)'}>
                <Input type="number" inputMode="decimal" step="0.5" min={draft.kind === 'RECEIPT_HAIRCUT' ? 0.01 : -50} max={100} value={draft.pct} onChange={(e) => setDraft({ ...draft, pct: e.target.value })} />
              </Field>
            )}
            {draft.kind === 'REMOVE_ITEM' && (
              <Field label="Item" className={s.formWide}>
                <Select value={draft.item_key} onChange={(e) => setDraft({ ...draft, item_key: e.target.value })}>
                  <option value="">Pick an item…</option>
                  {removable.map((i) => (
                    <option key={i.key} value={i.key}>
                      {i.date} · {i.label}
                      {i.party ? ` · ${i.party}` : ''} · {i.direction === 'IN' ? '+' : '−'}
                      {usd(i.amountCents)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {(draft.kind === 'LINE_DRAW' || draft.kind === 'LINE_PAYDOWN') && (
              <>
                <Field label="Amount">
                  <MoneyInput valueCents={draft.amount} onChangeCents={(c) => setDraft({ ...draft, amount: c })} />
                </Field>
                <Field label="Date">
                  <Input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
                </Field>
              </>
            )}
            <Field label="Note (optional)" className={s.formWide}>
              <Input value={draft.note} maxLength={1000} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Why — e.g. ‘Acme warned of a slow quarter’" />
            </Field>
            <div>
              <Button variant="primary" icon="plus" disabled={add.isLoading} onClick={() => void submit()}>
                {add.isLoading ? 'Adding…' : 'Add lever'}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function uniqParties(items: ReadonlyArray<{ partyId: string | null; party: string | null; amountCents: number }>): Array<{ id: string; name: string; cents: number }> {
  const m = new Map<string, { id: string; name: string; cents: number }>();
  for (const i of items) {
    if (!i.partyId) continue;
    const e = m.get(i.partyId) ?? { id: i.partyId, name: i.party ?? 'Unnamed', cents: 0 };
    e.cents += i.amountCents;
    m.set(i.partyId, e);
  }
  return Array.from(m.values()).sort((a, b) => b.cents - a.cents);
}
