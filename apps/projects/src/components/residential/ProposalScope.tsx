'use client';

import { useState } from 'react';
import { Button, Check, Field, Input, MoneyInput, Select, Textarea, WidgetState, money } from '@meritbooks/merit-ui';
import type { AssemblyRow, CatalogItemRow, ProposalLineRow, ProposalOptionRow, ProposalRow } from '@/lib/residential/types';
import { byRoom } from '@/lib/residential/labels';
import { useMoneyVis } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section, parseNum } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';

const COST_TYPES = [['MATERIALS', 'Material'], ['LABOR', 'Labor (own crew)'], ['SUBCONTRACTOR', 'Subcontract'], ['EQUIPMENT', 'Equipment'], ['OTHER', 'Other']] as const;
const TAX_FOR: Record<string, string> = { MATERIALS: 'MATERIAL', LABOR: 'LABOR', SUBCONTRACTOR: 'SUBCONTRACT', EQUIPMENT: 'EQUIPMENT', OTHER: 'OTHER' };

export function ProposalScope({ proposal: p, lines, options, catalog, editable }: {
  proposal: ProposalRow; lines: ProposalLineRow[]; options: ProposalOptionRow[]; catalog: { items: CatalogItemRow[]; assemblies: AssemblyRow[] }; editable: boolean;
}) {
  const mv = useMoneyVis();
  const { act, busy, error } = useOps();
  const [adding, setAdding] = useState<'line' | 'catalog' | null>(null);
  const optName = new Map(options.map((o) => [o.id, o.label]));
  const base = lines.filter((l) => !l.option_id);
  const rooms = byRoom(base);
  const url = `/api/residential/proposals/${p.id}/lines`;
  const remove = (l: ProposalLineRow) => void act(`del-${l.id}`, 'delete', `${url}?lineId=${l.id}`, undefined, `Removed ${l.description}`);

  return (
    <div className="stack">
      {editable && (
        <div className="btn-row">
          <Button variant={adding === 'catalog' ? 'primary' : 'default'} icon="plus" onClick={() => setAdding(adding === 'catalog' ? null : 'catalog')} disabled={!catalog.items.length && !catalog.assemblies.length} title={!catalog.items.length && !catalog.assemblies.length ? 'The catalog is empty' : undefined}>From the catalog</Button>
          <Button variant={adding === 'line' ? 'primary' : 'default'} icon="plus" onClick={() => setAdding(adding === 'line' ? null : 'line')}>Line</Button>
        </div>
      )}
      {adding === 'catalog' && <CatalogAdd proposalId={p.id} catalog={catalog} options={options} onDone={() => setAdding(null)} />}
      {adding === 'line' && <LineAdd proposalId={p.id} options={options} costPlus={p.contract_type.startsWith('COST_PLUS')} onDone={() => setAdding(null)} />}
      <Failure text={error} />
      {base.length === 0 ? (
        <WidgetState state={{ kind: 'empty', title: 'No scope yet', body: editable ? 'Add assemblies from the catalog (material + install labor in one step) or type lines. Mark an allowance line to create the homeowner’s selections when it is accepted.' : 'Nothing is priced on this proposal.' }} />
      ) : rooms.map((r) => (
        <Section key={r.room} title={r.room} meta={mv.contract ? money(r.lines.reduce((s, l) => s + l.price_cents, 0)) : undefined}>
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th>Description</th><th className="n">Qty</th>{mv.cost && <th className="n">Cost</th>}{mv.contract && <th className="n">Price</th>}{editable && <th aria-label="Remove" />}</tr></thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <span className="l1">{l.description}</span>
                      <span className="l2">{[l.is_allowance ? `Allowance${l.allowance_category ? ` · ${l.allowance_category}` : ''}` : null, l.cost_type === 'LABOR' && l.labor_hours ? `${l.labor_hours} h` : null,
                        l.is_contingency ? 'Contingency' : null, !l.cost_code_id ? 'No cost code' : null, !l.client_visible ? 'Rolled into the room total' : null].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td className="n">{Math.round(l.qty * 100) / 100} {l.uom}</td>
                    {mv.cost && <td className="n">{l.cost_cents == null ? '—' : money(l.cost_cents)}</td>}
                    {mv.contract && <td className="n">{money(l.price_cents)}</td>}
                    {editable && <td className="n"><Button variant="quiet" disabled={busy === `del-${l.id}`} onClick={() => remove(l)} aria-label={`Remove ${l.description}`}>Remove</Button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ))}
      {lines.some((l) => l.option_id) && (
        <p className="t-cap">{lines.filter((l) => l.option_id).length} more lines sit on options ({[...new Set(lines.filter((l) => l.option_id).map((l) => optName.get(l.option_id!) ?? ''))].join(', ')}); see Options.</p>
      )}
    </div>
  );
}

function CatalogAdd({ proposalId, catalog, options, onDone }: { proposalId: string; catalog: { items: CatalogItemRow[]; assemblies: AssemblyRow[] }; options: ProposalOptionRow[]; onDone: () => void }) {
  const mv = useMoneyVis();
  const { act, busy, error } = useOps();
  const [pick, setPick] = useState('');
  const [qty, setQty] = useState('1');
  const [room, setRoom] = useState('');
  const [optionId, setOptionId] = useState('');
  const q = parseNum(qty);
  const [kind, id] = pick.split(':') as ['a' | 'i' | '', string | undefined];
  const go = async () => {
    if (!id || !q || q <= 0) return;
    const r = await act<{ added: number }>('catalog', 'post', `/api/residential/proposals/${proposalId}`, {
      op: 'catalog', catalogItemId: kind === 'i' ? id : null, assemblyId: kind === 'a' ? id : null, qty: q, room: room.trim() || null, optionId: optionId || null,
    }, (d) => `Added ${d.added} line${d.added === 1 ? '' : 's'}`);
    if (r) onDone();
  };
  return (
    <Section title="Add from the catalog" meta="Material and its install labor land together">
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <Field label="Assembly or item">
          <Select value={pick} onChange={(e) => setPick(e.target.value)} autoFocus>
            <option value="">Pick one</option>
            {catalog.assemblies.length > 0 && <optgroup label="Assemblies">{catalog.assemblies.map((a) => <option key={a.id} value={`a:${a.id}`}>{a.code} · {a.name} (per {a.uom})</option>)}</optgroup>}
            <optgroup label="Items">{catalog.items.map((i) => <option key={i.id} value={`i:${i.id}`}>{i.code} · {i.name}{mv.contract && i.unit_price_cents != null ? ` · ${money(i.unit_price_cents)}/${i.uom}` : ''}</option>)}</optgroup>
          </Select>
        </Field>
        <div className="mp-form-2">
          <Field label="Quantity" error={qty && (!q || q <= 0) ? 'A quantity above zero' : undefined}><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="Room"><Input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Kitchen" maxLength={80} /></Field>
        </div>
        {options.length > 0 && (
          <Field label="On an option" help="Leave empty for the base scope">
            <Select value={optionId} onChange={(e) => setOptionId(e.target.value)}><option value="">Base scope</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
          </Field>
        )}
        <Failure text={error} />
        <div className="btn-row"><Button onClick={onDone}>Cancel</Button><Button variant="primary" type="submit" disabled={!id || !q || busy === 'catalog'}>Add</Button></div>
      </form>
    </Section>
  );
}

function LineAdd({ proposalId, options, costPlus, onDone }: { proposalId: string; options: ProposalOptionRow[]; costPlus: boolean; onDone: () => void }) {
  const mv = useMoneyVis();
  const { act, busy, error } = useOps();
  const [desc, setDesc] = useState('');
  const [room, setRoom] = useState('');
  const [costType, setCostType] = useState<(typeof COST_TYPES)[number][0]>('MATERIALS');
  const [qty, setQty] = useState('1');
  const [uom, setUom] = useState('EA');
  const [unitCost, setUnitCost] = useState<number | null>(null);
  const [markup, setMarkup] = useState<number | null>(null);
  const [unitPrice, setUnitPrice] = useState<number | null>(null);
  const [hours, setHours] = useState('');
  const [allowance, setAllowance] = useState(false);
  const [category, setCategory] = useState('');
  const [titles, setTitles] = useState('');
  const [optionId, setOptionId] = useState('');
  const [visible, setVisible] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const q = parseNum(qty);
  const h = parseNum(hours);
  const go = async () => {
    if (!desc.trim()) return setErr('Describe the line.');
    if (!q || q <= 0) return setErr('A quantity above zero.');
    if (costType === 'LABOR' && (h == null || h <= 0) && unitCost == null) return setErr('Labor needs hours (priced from the labor rate) or a unit cost.');
    setErr(null);
    const r = await act('line', 'post', `/api/residential/proposals/${proposalId}/lines`, {
      description: desc.trim(), room: room.trim() || null, costType, qty: q, uom: uom.trim() || 'EA', unitCostCents: unitCost ?? undefined,
      markupPct: costPlus ? undefined : markup, unitPriceCents: unitPrice, laborHours: costType === 'LABOR' ? h : null,
      isAllowance: allowance, allowanceCategory: allowance ? category.trim() || null : null,
      selectionTitles: allowance ? titles.split('\n').map((t) => t.trim()).filter(Boolean) : undefined,
      optionId: optionId || null, taxCategory: TAX_FOR[costType], clientVisible: visible,
    }, `Added ${desc.trim()}`);
    if (r) onDone();
  };
  return (
    <Section title="Add a line" meta={costPlus ? 'Cost plus: lines carry cost; the fee is added on top' : 'Price = cost × (1 + markup) unless you type a price'}>
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <Field label="Description" error={err ?? undefined}><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} autoFocus placeholder="Quartz countertop, 3 cm" /></Field>
        <div className="mp-form-2">
          <Field label="Room"><Input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Kitchen" maxLength={80} /></Field>
          <Field label="Kind">
            <Select value={costType} onChange={(e) => setCostType(e.target.value as typeof costType)}>{COST_TYPES.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</Select>
          </Field>
        </div>
        <div className="mp-form-2">
          <Field label="Quantity"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="Unit"><Input value={uom} onChange={(e) => setUom(e.target.value)} maxLength={12} /></Field>
        </div>
        {costType === 'LABOR' && <Field label="Hours" help="Priced at pay + burden + overhead; the budget keeps pay + burden"><Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>}
        {mv.cost && (
          <div className="mp-form-2">
            <Field label="Unit cost"><MoneyInput valueCents={unitCost} onChangeCents={setUnitCost} placeholder="0.00" /></Field>
            {!costPlus && <Field label="Markup" help="Empty uses the company default"><PctInput value={markup} onChange={setMarkup} max={1000} placeholder="Default" /></Field>}
          </div>
        )}
        {mv.contract && !costPlus && <Field label="Unit price" help="Overrides the markup"><MoneyInput valueCents={unitPrice} onChangeCents={setUnitPrice} placeholder="From cost" /></Field>}
        <Check checked={allowance} onChange={(e) => setAllowance(e.target.checked)} label="Allowance — the homeowner picks later" />
        {allowance && (
          <>
            <Field label="Allowance category"><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Tile" maxLength={80} /></Field>
            <Field label="Selections it creates" help="One per line; several share this allowance"><Textarea value={titles} onChange={(e) => setTitles(e.target.value)} rows={3} placeholder={'Kitchen backsplash tile\nPrimary bath floor tile'} /></Field>
          </>
        )}
        {options.length > 0 && (
          <Field label="On an option"><Select value={optionId} onChange={(e) => setOptionId(e.target.value)}><option value="">Base scope</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select></Field>
        )}
        <Check checked={visible} onChange={(e) => setVisible(e.target.checked)} label="Show this line to the homeowner (off rolls it into the room total)" />
        <Failure text={error} />
        <div className="btn-row"><Button onClick={onDone}>Cancel</Button><Button variant="primary" type="submit" disabled={busy === 'line'}>Add line</Button></div>
      </form>
    </Section>
  );
}
