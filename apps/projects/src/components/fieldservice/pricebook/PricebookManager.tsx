'use client';

import { useMemo, useRef, useState } from 'react';
import {
  Button, ButtonLink, Check, Field, InlineNotice, Input, MoneyInput, Panel, PanelSection, Select, Tag, Textarea, WidgetState, api, count, money,
  pct, toast, useDebounce,
} from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { parsePricebookCsv } from '@/lib/fieldservice/csv';
import { DEFAULT_PRICE_SETTINGS, priceItem, type MarkupTier, type PriceSettings, type RoundingRule } from '@/lib/fieldservice/pricing';
import type { PricebookData } from '@/lib/fieldservice/queries';
import type { BulkPreview, PricebookImportReport, PricebookItemRow } from '@/lib/fieldservice/types';
import { PctInput, parseNum } from '@/components/ops/common/bits';

export interface PricebookManagerProps {
  companyId: string;
  data: PricebookData;
  /** projects.financials:view at the company — cost, margin, burdened rate, ladder. */
  seesCost: boolean;
  /** settings:configure or financials:edit — may change the book. */
  canEdit: boolean;
  canSeed: boolean;
}

type Kind = PricebookItemRow['kind'];
const KIND: Record<Kind, string> = { SERVICE: 'Task', MATERIAL: 'Material', EQUIPMENT: 'Equipment', FEE: 'Fee', MEMBERSHIP: 'Membership' };
const ROUND: Record<RoundingRule, string> = { NONE: 'To the cent', WHOLE: 'Up to the dollar', FIVE: 'Up to $5', NINE: 'Up to the next $…9' };

function settingsOf(d: PricebookData): PriceSettings {
  const s = d.settings;
  if (!s) return DEFAULT_PRICE_SETTINGS;
  return {
    burdenedRateCents: Number(s.burdened_rate_cents), targetGmPct: Number(s.target_gm_pct), equipmentGmPct: Number(s.equipment_gm_pct),
    memberDiscountPct: Number(s.member_discount_pct), afterHoursMultiplier: Number(s.after_hours_multiplier), rounding: s.rounding,
  };
}

/**
 * Price-book manager (FS-44/45/46/47): categories, flat-rate tasks with bundled materials, the
 * formula (burdened rate ÷ (1 − target GM) + material markup ladder), member and after-hours
 * prices, Excel round trip and bulk change with a margin preview. Cost and margin show only with
 * job financials; everyone else sees sell prices.
 */
export function PricebookManager(p: PricebookManagerProps) {
  const { readOnly } = useShell();
  const edit = p.canEdit && !readOnly;
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 200).trim().toLowerCase();
  const [cat, setCat] = useState('');
  const [kind, setKind] = useState<'' | Kind>('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [panel, setPanel] = useState<'item' | 'bulk' | 'import' | 'settings' | null>(null);
  const settings = settingsOf(p.data);
  const ladder: MarkupTier[] = p.data.tiers.map((t) => ({ upToCents: t.up_to_cents == null ? null : Number(t.up_to_cents), markupPct: Number(t.markup_pct) }));
  const catName = new Map(p.data.categories.map((c) => [c.id, c.name]));
  const byId = new Map(p.data.items.map((i) => [i.id, i]));
  const shown = useMemo(() => p.data.items.filter((i) =>
    (!cat || i.category_id === cat) && (!kind || i.kind === kind) && (!dq || i.code.toLowerCase().includes(dq) || i.name.toLowerCase().includes(dq))), [p.data.items, cat, kind, dq]);
  const below = p.seesCost && p.data.settings
    ? p.data.items.filter((i) => i.is_active && i.cost_cents != null && i.price_cents > 0 && (i.price_cents - Number(i.cost_cents)) / i.price_cents < Number(p.data.settings!.price_floor_gm_pct)).length
    : 0;
  const cur = cursor ? byId.get(cursor) ?? null : null;

  if (!p.data.items.length) {
    return <Starter companyId={p.companyId} canSeed={p.canSeed && !readOnly} />;
  }

  return (
    <div className={panel ? 'fs-grid' : undefined}>
      <div className="stack">
        <div className="fs-toolbar">
          <Field label="Search"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code or name" style={{ width: 220 }} /></Field>
          <Field label="Category">
            <Select value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">Every category</option>
              {p.data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as '' | Kind)}>
              <option value="">Everything</option>
              {(Object.keys(KIND) as Kind[]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}
            </Select>
          </Field>
          <span className="sp" />
          <ButtonLink href={`/api/fieldservice/pricebook/export?companyId=${p.companyId}`} icon="upload">Export to Excel</ButtonLink>
          {edit && <Button onClick={() => setPanel('import')}>Import</Button>}
          {edit && <Button onClick={() => setPanel('bulk')}>Bulk change</Button>}
          {edit && p.seesCost && <Button onClick={() => setPanel('settings')}>Formula</Button>}
        </div>
        {below > 0 && <InlineNotice tone="warn" title={`${count(below)} item(s) price below the margin floor.`}>Use Bulk change → target margin, or reprice after a cost update.</InlineNotice>}
        <section className="fs-card fs-scroll" aria-label="Price book">
          <table className="fs-table">
            <thead>
              <tr>
                <th>Code</th><th>Name</th><th>Kind</th><th className="n">Hours</th><th className="n">Price</th><th className="n">Member</th><th className="n">After hours</th>
                {p.seesCost && <><th className="n">Cost</th><th className="n">Margin</th></>}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 1500).map((i) => {
                const m = p.seesCost && i.cost_cents != null && i.price_cents > 0 ? (i.price_cents - Number(i.cost_cents)) / i.price_cents : null;
                return (
                  <tr key={i.id} data-click aria-selected={i.id === cursor} tabIndex={0}
                    onClick={() => { setCursor(i.id); setPanel('item'); }} onKeyDown={(e) => { if (e.key === 'Enter') { setCursor(i.id); setPanel('item'); } }}>
                    <td><span className="code">{i.code}</span></td>
                    <td><span className="l1">{i.name}{!i.is_active && ' · inactive'}</span><span className="l2">{i.category_id ? catName.get(i.category_id) : ''}{i.gbb_tier ? ` · ${i.gbb_tier.toLowerCase()}` : ''}</span></td>
                    <td>{KIND[i.kind]}{i.price_locked && <> <Tag>Manual</Tag></>}</td>
                    <td className="n">{i.task_hours ?? ''}</td>
                    <td className="n">{money(i.price_cents)}</td>
                    <td className="n">{i.member_price_cents == null ? '' : money(i.member_price_cents)}</td>
                    <td className="n">{i.after_hours_price_cents == null ? '' : money(i.after_hours_price_cents)}</td>
                    {p.seesCost && <><td className="n">{i.cost_cents == null ? '—' : money(Number(i.cost_cents))}</td><td className="n">{m == null ? '—' : pct(m)}</td></>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length === 0 && <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'Nothing matches', body: 'Clear the search or pick another category.' }} /></div>}
          {(shown.length > 1500 || p.data.capped) && <p className="t-cap" style={{ padding: 12 }}>Showing the first {count(Math.min(shown.length, 1500))}. Narrow by category or search.</p>}
        </section>
      </div>
      {panel === 'item' && cur && (
        <ItemPanel key={cur.id} item={cur} data={p.data} settings={settings} ladder={ladder} seesCost={p.seesCost} canEdit={edit} onClose={() => setPanel(null)} />
      )}
      {panel === 'bulk' && <BulkPanel companyId={p.companyId} categories={p.data.categories} filterCat={cat} filterKind={kind} seesCost={p.seesCost} onClose={() => setPanel(null)} />}
      {panel === 'import' && <ImportPanel companyId={p.companyId} onClose={() => setPanel(null)} />}
      {panel === 'settings' && <SettingsPanel companyId={p.companyId} data={p.data} onClose={() => setPanel(null)} />}
    </div>
  );
}

function Starter({ companyId, canSeed }: { companyId: string; canSeed: boolean }) {
  const [trades, setTrades] = useState<Array<'HVAC' | 'PLUMBING' | 'ELECTRICAL'>>(['HVAC', 'PLUMBING', 'ELECTRICAL']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function seed() {
    setBusy(true); setErr(null);
    const r = await api.post<{ seeded: Record<string, number> }>('/api/fieldservice/pricebook', { op: 'seed', companyId, trades });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    toast(`Loaded the starter setup — ${r.data?.seeded.price_book_items ?? 0} items priced`);
    window.location.reload();
  }
  return (
    <div className="surface" style={{ maxWidth: 760 }}>
      <WidgetState state={{
        kind: 'empty', title: 'No price book yet',
        body: canSeed
          ? 'Load the starter setup: business units, arrival windows, scripted job types (No Cool, No Heat, Tune-up, Leak, Water Heater, Drain, Panel, Replacement Estimate, Recall), starter capacity, membership plans, financing plans and a priced flat-rate book with bundled materials. Or import your old system’s export.'
          : 'An owner loads the starter setup or imports the old system’s price book.',
        action: canSeed ? (
          <div className="stack">
            <div className="row" style={{ gap: 16 }}>
              {(['HVAC', 'PLUMBING', 'ELECTRICAL'] as const).map((t) => (
                <Check key={t} label={t === 'HVAC' ? 'HVAC' : t === 'PLUMBING' ? 'Plumbing' : 'Electrical'} checked={trades.includes(t)} onChange={(e) => setTrades(e.target.checked ? [...trades, t] : trades.filter((x) => x !== t))} />
              ))}
            </div>
            <Button variant="primary" disabled={busy || trades.length === 0} onClick={() => void seed()}>Load the starter setup</Button>
          </div>
        ) : undefined,
      }} />
      {err && <InlineNotice tone="neg" title="Not loaded.">{err}</InlineNotice>}
    </div>
  );
}

function ItemPanel({ item, data, settings, ladder, seesCost, canEdit, onClose }: {
  item: PricebookItemRow; data: PricebookData; settings: PriceSettings; ladder: MarkupTier[]; seesCost: boolean; canEdit: boolean; onClose: () => void;
}) {
  const materials = data.items.filter((i) => i.kind === 'MATERIAL');
  const [name, setName] = useState(item.name);
  const [hours, setHours] = useState(item.task_hours == null ? '' : String(item.task_hours));
  const [cost, setCost] = useState<number | null>(item.kind === 'SERVICE' ? null : item.cost_cents == null ? null : Number(item.cost_cents));
  const [gm, setGm] = useState<number | null>(item.target_gm_pct == null ? null : Number(item.target_gm_pct));
  const [locked, setLocked] = useState(item.price_locked);
  const [price, setPrice] = useState<number | null>(item.price_cents);
  const [desc, setDesc] = useState(item.customer_description ?? '');
  const [tier, setTier] = useState(item.gbb_tier ?? '');
  const [bundle, setBundle] = useState(() => data.bundles.filter((b) => b.service_item_id === item.id).map((b) => ({ itemId: b.material_item_id, qty: Number(b.qty) })));
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const matCost = new Map(materials.map((m) => [m.id, m.cost_cents == null ? null : Number(m.cost_cents)]));
  const preview = seesCost ? priceItem({
    kind: item.kind, taskHours: parseNum(hours), costCents: cost, targetGmPct: gm, priceLocked: locked, currentPriceCents: price ?? item.price_cents,
    materials: bundle.map((b) => ({ qty: b.qty, unitCostCents: matCost.get(b.itemId) ?? 0 })),
  }, settings, ladder) : null;

  async function save() {
    setBusy(true); setErr(null);
    const r = await api.patch(`/api/fieldservice/pricebook/items/${item.id}`, {
      name, taskHours: item.kind === 'SERVICE' ? parseNum(hours) : undefined, costCents: item.kind !== 'SERVICE' && seesCost ? cost : undefined,
      targetGmPct: seesCost ? gm : undefined, priceLocked: locked, priceCents: locked && price != null ? price : undefined, customerDescription: desc, gbbTier: tier || null,
      materials: item.kind === 'SERVICE' ? bundle : undefined,
    });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    toast(`Saved ${item.code}`);
    window.location.reload();
  }

  return (
    <Panel aria-label={`Edit ${item.code}`} eyebrow={['Price book', KIND[item.kind]]} title={item.code} meta={item.name} onClose={onClose}
      figure={money(preview?.priceCents ?? item.price_cents)}
      foot={canEdit ? <div className="row" style={{ gap: 8 }}><Button variant="primary" disabled={busy} onClick={() => void save()}>Save and reprice</Button><Button variant="quiet" onClick={onClose}>Cancel</Button></div> : undefined}>
      <PanelSection title="What the customer sees">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} maxLength={200} /></Field>
        <Field label="Customer description" help="Shown on option cards"><Textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} disabled={!canEdit} maxLength={2000} /></Field>
        <Field label="Good / better / best tier"><Select value={tier} onChange={(e) => setTier(e.target.value)} disabled={!canEdit}><option value="">None</option><option value="GOOD">Good</option><option value="BETTER">Better</option><option value="BEST">Best</option></Select></Field>
      </PanelSection>
      <PanelSection title="Price">
        {item.kind === 'SERVICE' && <Field label="Task hours"><Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} disabled={!canEdit} /></Field>}
        {item.kind !== 'SERVICE' && seesCost && <Field label="Unit cost"><MoneyInput valueCents={cost} onChangeCents={setCost} disabled={!canEdit} /></Field>}
        {seesCost && item.kind !== 'FEE' && <Field label="Target margin" help={`Blank = the company’s ${pct(item.kind === 'EQUIPMENT' ? settings.equipmentGmPct : settings.targetGmPct)}`}><PctInput value={gm} onChange={setGm} /></Field>}
        <Check label="Manual price (the formula does not move it)" checked={locked} onChange={(e) => setLocked(e.target.checked)} disabled={!canEdit} />
        {locked && <Field label="Price"><MoneyInput valueCents={price} onChangeCents={setPrice} disabled={!canEdit} /></Field>}
        {preview && (
          <dl className="kv">
            <dt>Price</dt><dd className="tnum">{money(preview.priceCents)}</dd>
            <dt>Member</dt><dd className="tnum">{money(preview.memberPriceCents)}</dd>
            <dt>After hours</dt><dd className="tnum">{money(preview.afterHoursPriceCents)}</dd>
            {item.kind === 'SERVICE' && <><dt>Labor cost</dt><dd className="tnum">{money(preview.laborCostCents)}</dd></>}
            <dt>Material cost</dt><dd className="tnum">{money(preview.materialCostCents)}</dd>
            <dt>Margin</dt><dd className="tnum">{preview.marginPct == null ? '—' : pct(preview.marginPct)}</dd>
          </dl>
        )}
        {!seesCost && <p className="t-cap">Member {item.member_price_cents == null ? '—' : money(item.member_price_cents)} · after hours {item.after_hours_price_cents == null ? '—' : money(item.after_hours_price_cents)}</p>}
      </PanelSection>
      {item.kind === 'SERVICE' && (
        <PanelSection title="Bundled materials">
          {bundle.length === 0 && <p className="t-cap">No materials — the price is labor only.</p>}
          <ul className="fs-list">
            {bundle.map((b, i) => {
              const m = data.items.find((x) => x.id === b.itemId);
              return (
                <li key={b.itemId}>
                  <span className="l1"><span className="code">{m?.code}</span> {m?.name}</span><span className="sp" />
                  <Input aria-label="Quantity" inputMode="decimal" style={{ width: 72 }} value={String(b.qty)} disabled={!canEdit}
                    onChange={(e) => { const n = parseNum(e.target.value); if (n != null && n > 0) setBundle(bundle.map((x, j) => (j === i ? { ...x, qty: n } : x))); }} />
                  {canEdit && <Button variant="quiet" onClick={() => setBundle(bundle.filter((_, j) => j !== i))}>Remove</Button>}
                </li>
              );
            })}
          </ul>
          {canEdit && (
            <div className="row" style={{ gap: 8 }}>
              <Select aria-label="Add a material" value={add} onChange={(e) => setAdd(e.target.value)}>
                <option value="">Add a material</option>
                {materials.filter((m) => !bundle.some((b) => b.itemId === m.id)).map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
              </Select>
              <Button disabled={!add} onClick={() => { setBundle([...bundle, { itemId: add, qty: 1 }]); setAdd(''); }}>Add</Button>
            </div>
          )}
        </PanelSection>
      )}
      {err && <InlineNotice tone="neg" title="Not saved.">{err}</InlineNotice>}
    </Panel>
  );
}

function BulkPanel({ companyId, categories, filterCat, filterKind, seesCost, onClose }: { companyId: string; categories: PricebookData['categories']; filterCat: string; filterKind: string; seesCost: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<'PCT' | 'TARGET_GM' | 'HOURS_PCT' | 'REPRICE'>('PCT');
  const [value, setValue] = useState<number | null>(0.05);
  const [valueText, setValueText] = useState('5');
  const [cat, setCat] = useState(filterCat);
  const [kind, setKind] = useState(filterKind);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run(apply: boolean) {
    setBusy(true); setErr(null);
    const r = await api.post<{ preview: BulkPreview }>('/api/fieldservice/pricebook', {
      op: 'bulk', companyId, filter: { categoryId: cat || null, kind: kind || null }, mode, value: mode === 'REPRICE' ? null : value, preview: !apply,
    });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    setPreview(r.data?.preview ?? null);
    if (apply) { toast(`Changed ${count(r.data?.preview.count ?? 0)} prices`); window.location.reload(); }
  }
  return (
    <Panel aria-label="Bulk change" eyebrow="Price book" title="Bulk change" meta="Preview the margin effect before anything moves" onClose={onClose}
      foot={<div className="row" style={{ gap: 8 }}><Button disabled={busy} onClick={() => void run(false)}>Preview</Button><Button variant="primary" disabled={busy || !preview || preview.applied} onClick={() => void run(true)} count={preview ? count(preview.count) : undefined}>Apply</Button></div>}>
      <PanelSection title="Which items">
        <Field label="Category"><Select value={cat} onChange={(e) => { setCat(e.target.value); setPreview(null); }}><option value="">Every category</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label="Kind"><Select value={kind} onChange={(e) => { setKind(e.target.value); setPreview(null); }}><option value="">Everything</option><option value="SERVICE">Tasks</option><option value="MATERIAL">Materials</option><option value="EQUIPMENT">Equipment</option></Select></Field>
      </PanelSection>
      <PanelSection title="Change">
        <Field label="How">
          <Select value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setPreview(null); }}>
            <option value="PCT">Raise or lower prices by a percent</option>
            {seesCost && <option value="TARGET_GM">Set a target margin (formula items)</option>}
            <option value="HOURS_PCT">Change task hours by a percent</option>
            <option value="REPRICE">Reprice from the formula (after a cost update)</option>
          </Select>
        </Field>
        {mode !== 'REPRICE' && (
          <Field label={mode === 'TARGET_GM' ? 'Target margin %' : 'Percent (negative lowers)'}>
            <Input inputMode="decimal" value={valueText} onChange={(e) => { setValueText(e.target.value); const n = parseNum(e.target.value); setValue(n == null ? null : Math.round(n * 100) / 10000); setPreview(null); }} />
          </Field>
        )}
      </PanelSection>
      {preview && (
        <PanelSection title={`${count(preview.count)} item(s)`}>
          <dl className="kv">
            <dt>Average margin before</dt><dd className="tnum">{preview.avg_margin_before == null ? '—' : pct(preview.avg_margin_before)}</dd>
            <dt>Average margin after</dt><dd className="tnum">{preview.avg_margin_after == null ? '—' : pct(preview.avg_margin_after)}</dd>
            <dt>Below the floor after</dt><dd className="tnum">{count(preview.below_floor)}</dd>
          </dl>
          <table className="fs-table">
            <thead><tr><th>Code</th><th className="n">Was</th><th className="n">Now</th><th className="n">Margin</th></tr></thead>
            <tbody>{preview.rows.slice(0, 60).map((r) => <tr key={r.id}><td className="code">{r.code}</td><td className="n">{money(r.old_price_cents)}</td><td className="n">{money(r.price_cents)}</td><td className="n">{r.margin_pct == null ? '—' : pct(r.margin_pct)}</td></tr>)}</tbody>
          </table>
        </PanelSection>
      )}
      {err && <InlineNotice tone="neg" title="Not changed.">{err}</InlineNotice>}
    </Panel>
  );
}

function ImportPanel({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const file = useRef<HTMLInputElement | null>(null);
  const [parsed, setParsed] = useState<ReturnType<typeof parsePricebookCsv> | null>(null);
  const [report, setReport] = useState<PricebookImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function read(f: File) {
    setErr(null); setReport(null);
    if (f.size > 8_000_000) { setErr('That file is over 8 MB. Split it by category.'); return; }
    if (!/\.csv$/i.test(f.name)) { setErr('Save the sheet as CSV (File → Save As → CSV UTF-8) and pick that file.'); return; }
    setParsed(parsePricebookCsv(await f.text()));
  }
  async function run(dryRun: boolean) {
    if (!parsed?.rows.length) return;
    setBusy(true); setErr(null);
    const r = await api.post<{ report: PricebookImportReport }>('/api/fieldservice/pricebook', { op: 'import', companyId, rows: parsed.rows, dryRun });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    setReport(r.data?.report ?? null);
    if (!dryRun) { toast(`Imported ${count((r.data?.report.inserted ?? 0) + (r.data?.report.updated ?? 0))} items`); window.location.reload(); }
  }
  return (
    <Panel aria-label="Import" eyebrow="Price book" title="Import from Excel" meta="Columns are matched by name: code, name, kind, category, hours, cost, price, materials (CODE:qty;CODE:qty)" onClose={onClose}
      foot={<div className="row" style={{ gap: 8 }}><Button disabled={busy || !parsed?.rows.length} onClick={() => void run(true)}>Check</Button><Button variant="primary" disabled={busy || !report || report.dry_run === false || report.error_count > 0 && report.inserted + report.updated === 0} onClick={() => void run(false)}>Import</Button></div>}>
      <PanelSection title="1 // Pick the file">
        <input ref={file} type="file" accept=".csv,text/csv" aria-label="Price book CSV" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} />
        <p className="t-cap">Tip: export first, edit in Excel, and import the same sheet — the round trip keeps every column.</p>
      </PanelSection>
      {parsed && (
        <PanelSection title="2 // What was read">
          <p className="t-ui">{count(parsed.rows.length)} row(s) ready{parsed.problems.length ? `, ${count(parsed.problems.length)} skipped` : ''}.</p>
          {parsed.problems.slice(0, 10).map((x) => <p key={`${x.line}-${x.error}`} className="t-cap">Line {x.line}: {x.error}</p>)}
        </PanelSection>
      )}
      {report && (
        <PanelSection title={report.dry_run ? '3 // Check result (nothing saved yet)' : 'Imported'}>
          <dl className="kv">
            <dt>New items</dt><dd className="tnum">{count(report.inserted)}</dd>
            <dt>Changed</dt><dd className="tnum">{count(report.updated)}</dd>
            <dt>Unchanged</dt><dd className="tnum">{count(report.unchanged)}</dd>
            <dt>Errors</dt><dd className="tnum">{count(report.error_count)}</dd>
          </dl>
          {report.errors.slice(0, 20).map((x) => <p key={`${x.row}-${x.code}`} className="t-cap">Row {x.row} {x.code}: {x.error}</p>)}
        </PanelSection>
      )}
      {err && <InlineNotice tone="neg" title="Not imported.">{err}</InlineNotice>}
    </Panel>
  );
}

function SettingsPanel({ companyId, data, onClose }: { companyId: string; data: PricebookData; onClose: () => void }) {
  const s = settingsOf(data);
  const [rate, setRate] = useState<number | null>(s.burdenedRateCents);
  const [gm, setGm] = useState<number | null>(s.targetGmPct);
  const [egm, setEgm] = useState<number | null>(s.equipmentGmPct);
  const [mem, setMem] = useState<number | null>(s.memberDiscountPct);
  const [ah, setAh] = useState(String(s.afterHoursMultiplier));
  const [round, setRound] = useState<RoundingRule>(s.rounding);
  const [floor, setFloor] = useState<number | null>(data.settings ? Number(data.settings.price_floor_gm_pct) : 0.4);
  const [tiers, setTiers] = useState(() => data.tiers.map((t) => ({ upToCents: t.up_to_cents == null ? null : Number(t.up_to_cents), markupPct: Number(t.markup_pct) }))
    .sort((a, b) => (a.upToCents ?? Infinity) - (b.upToCents ?? Infinity)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const mult = parseNum(ah);
    if (rate == null || gm == null || egm == null || mem == null || mult == null || floor == null) { setErr('Fill every field.'); return; }
    setBusy(true); setErr(null);
    const r = await api.post<{ repriced: number }>('/api/fieldservice/pricebook', {
      op: 'settings', companyId, burdenedRateCents: rate, targetGmPct: gm, equipmentGmPct: egm, memberDiscountPct: mem, afterHoursMultiplier: mult,
      rounding: round, priceFloorGmPct: floor, tiers,
    });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    toast(`Saved the formula and repriced ${count(r.data?.repriced ?? 0)} items`);
    window.location.reload();
  }
  return (
    <Panel aria-label="Formula" eyebrow="Price book" title="Price formula" meta="hours × burdened rate ÷ (1 − target margin) + material markup" onClose={onClose}
      foot={<Button variant="primary" disabled={busy} onClick={() => void save()}>Save and reprice everything</Button>}>
      <PanelSection title="Labor">
        <Field label="Burdened rate per hour" help="Pay + burden + overhead — from Books payroll actuals"><MoneyInput valueCents={rate} onChangeCents={setRate} /></Field>
        <Field label="Target gross margin (tasks)"><PctInput value={gm} onChange={setGm} /></Field>
        <Field label="Target gross margin (equipment)"><PctInput value={egm} onChange={setEgm} /></Field>
        <Field label="Margin floor" help="Items below it are flagged"><PctInput value={floor} onChange={setFloor} /></Field>
      </PanelSection>
      <PanelSection title="Member and after hours">
        <Field label="Member discount"><PctInput value={mem} onChange={setMem} /></Field>
        <Field label="After-hours multiplier" help="1.5 = time and a half"><Input inputMode="decimal" value={ah} onChange={(e) => setAh(e.target.value)} /></Field>
        <Field label="Rounding"><Select value={round} onChange={(e) => setRound(e.target.value as RoundingRule)}>{(Object.keys(ROUND) as RoundingRule[]).map((k) => <option key={k} value={k}>{ROUND[k]}</option>)}</Select></Field>
      </PanelSection>
      <PanelSection title="Material markup ladder">
        <table className="fs-table">
          <thead><tr><th>Unit cost up to</th><th className="n">Markup</th><th /></tr></thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i}>
                <td>{t.upToCents == null ? 'Everything above' : <MoneyInput aria-label="Up to" valueCents={t.upToCents} onChangeCents={(c) => setTiers(tiers.map((x, j) => (j === i ? { ...x, upToCents: c } : x)))} />}</td>
                <td className="n"><PctInput aria-label="Markup" value={t.markupPct} max={2000} onChange={(v) => setTiers(tiers.map((x, j) => (j === i ? { ...x, markupPct: v ?? 0 } : x)))} /></td>
                <td><Button variant="quiet" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>Remove</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button onClick={() => setTiers([...tiers.filter((t) => t.upToCents != null), { upToCents: 10000, markupPct: 1 }, ...tiers.filter((t) => t.upToCents == null)])}>Add a tier</Button>
      </PanelSection>
      {err && <InlineNotice tone="neg" title="Not saved.">{err}</InlineNotice>}
    </Panel>
  );
}
