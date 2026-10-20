'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button, ConfirmDialog, Field, InlineNotice, Input, KV, Meter, Panel, PanelSection, Select, Tag, count, shortDate, stepStrokes,
} from '@meritbooks/merit-ui';
import { durationText } from '@/lib/pm/ops/dispatch-math';
import { BOM_KIND_WORDS, OP_STATUS, PRODUCTION_STATUS_WORDS, WO_STATUS } from '@/lib/pm/ops/labels';
import { GATE_COPY, RELEASE_GATES, gateCopy, releaseSentence, type ReleaseGate } from '@/lib/pm/ops/release-gates';
import { BOM_KINDS, type BomKind, type BomLineRow, type RoutingRow, type WorkCenterRow } from '@/lib/pm/ops/types';
import type { ProductionDetail } from '@/lib/pm/ops/production-queries';
import { useShell } from '@/components/shell/ShellContext';
import { DetailState, Failure, StatusMark, parseNum } from '../common/bits';
import { useDetail, useOps } from '../common/useOps';

export interface ProductionPanelProps {
  id: string;
  jobLabel: string | null;
  centers: ReadonlyArray<WorkCenterRow>;
  routings: ReadonlyArray<RoutingRow>;
  today: string;
  onClose: () => void;
}

export function ProductionPanel(p: ProductionPanelProps) {
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const { data, error: loadError, isLoading, refetch } = useDetail<ProductionDetail>(`/api/ops/production/${p.id}`, version);
  const [failing, setFailing] = useState<string[] | null>(null);
  const [routingId, setRoutingId] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const center = useMemo(() => new Map(p.centers.map((c) => [c.id, c])), [p.centers]);
  const url = `/api/ops/production/${p.id}`;

  if (!data) {
    return <Panel eyebrow="Production order" title="Loading" onClose={p.onClose}><PanelSection><DetailState loading={isLoading} error={loadError} onRetry={() => void refetch()} what="Production order" /></PanelSection></Panel>;
  }
  const o = data.order;
  const engineering = o.status === 'NEW';
  const met: Record<ReleaseGate, boolean> = {
    drawings_approved: !!o.drawings_approved_at,
    bom_present: data.bom.length > 0,
    operations_present: data.operations.length > 0,
    selections_approved: !data.jobGatesFailing.includes('selections_approved'),
    has_budget: !data.jobGatesFailing.includes('has_budget'),
  };
  const done = data.operations.filter((x) => x.status === 'COMPLETE' || x.status === 'SKIPPED').length;
  const std = data.operations.reduce((s, x) => s + x.std_minutes, 0);
  const actual = data.operations.reduce((s, x) => s + x.actual_minutes, 0);
  const curIdx = data.operations.findIndex((x) => x.status !== 'COMPLETE' && x.status !== 'SKIPPED');

  const release = async () => {
    const r = await act<{ released: boolean; failing: string[] }>('release', 'post', url, { op: 'release' }, (d) => (d.released ? `Released ${o.number} to the shop` : null));
    if (r && !r.released) setFailing(r.failing);
    else setFailing(null);
  };

  return (
    <Panel
      eyebrow={[o.number ?? 'Production order', PRODUCTION_STATUS_WORDS[o.status] ?? WO_STATUS[o.status].word]}
      title={o.summary}
      meta={[p.jobLabel, `Quantity ${o.quantity}`].filter(Boolean).join(' · ')}
      onClose={p.onClose}
      foot={readOnly ? undefined : (
        <div className="btn-row" style={{ width: '100%' }}>
          {(o.status === 'NEW' || o.status === 'RELEASED' || o.status === 'IN_PROGRESS' || o.status === 'ON_HOLD') && <Button variant="quiet" onClick={() => setCancelOpen(true)}>Cancel</Button>}
          {(o.status === 'RELEASED' || o.status === 'IN_PROGRESS') && <Button onClick={() => setHoldOpen(true)}>Hold</Button>}
          {o.status === 'ON_HOLD' && <Button disabled={busy === 'resume'} onClick={() => void act('resume', 'post', url, { op: 'resume' }, `Resumed ${o.number}`)}>Resume</Button>}
          <span className="sp" />
          {engineering && <Button variant="primary" disabled={busy === 'release'} onClick={() => void release()}>Release to shop</Button>}
          {o.status === 'COMPLETE' && <Button variant="primary" disabled={busy === 'close'} onClick={() => void act('close', 'post', url, { op: 'close' }, `Closed ${o.number}`)}>Close</Button>}
        </div>
      )}
    >
      <PanelSection>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <StatusMark mark={WO_STATUS[o.status]} />
          {o.is_remake && <Tag tone="warn">Remake</Tag>}
          {data.operations.length > 0 && <Meter strokes={curIdx < 0 ? stepStrokes(data.operations.length, data.operations.length) : stepStrokes(data.operations.length, curIdx, { blocked: o.status === 'ON_HOLD' })} label={`Operation ${Math.min(done + 1, data.operations.length)} of ${data.operations.length}`} />}
        </div>
        <div style={{ marginTop: 12 }}>
          <KV items={[
            ...(o.promised_on ? [{ term: 'Promised', value: <span className={o.promised_on < p.today && o.status !== 'COMPLETE' && o.status !== 'CLOSED' ? 'neg b' : undefined}>{shortDate(o.promised_on, p.today)}</span> }] : []),
            { term: 'Standard', value: durationText(std) },
            { term: 'Actual so far', value: durationText(actual) },
            ...(o.released_at ? [{ term: 'Released', value: shortDate(o.released_at.slice(0, 10), p.today) }] : []),
            ...(o.hold_reason ? [{ term: 'On hold', value: o.hold_reason }] : []),
          ]} />
        </div>
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
      </PanelSection>

      {engineering && (
        <PanelSection title="Release checks">
          <ul className="ops-checks">
            {RELEASE_GATES.map((g) => {
              const copy = GATE_COPY[g];
              return (
                <li key={g}>
                  <span className={met[g] ? 'ok' : 'no'} aria-hidden="true">{met[g] ? '✓' : '×'}</span>
                  <span>
                    <span className="l1" style={{ fontWeight: 400 }}>{met[g] ? copy.label : copy.failing}</span>
                    {g === 'drawings_approved' && o.drawings_approved_at && <span className="l2">Approved {shortDate(o.drawings_approved_at.slice(0, 10), p.today)}</span>}
                  </span>
                  <span>
                    {!met[g] && copy.fix.href && <Link className="link" href={copy.fix.href(o.job_id)}>{copy.fix.label}</Link>}
                    {g === 'drawings_approved' && !readOnly && (
                      o.drawings_approved_at
                        ? <Button variant="quiet" disabled={busy === 'dwg'} onClick={() => void act('dwg', 'post', url, { op: 'revoke_drawings' }, 'Drawing approval withdrawn')}>Withdraw</Button>
                        : <Button disabled={busy === 'dwg'} onClick={() => void act('dwg', 'post', url, { op: 'approve_drawings' }, 'Shop drawings approved')}>Approve</Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {failing && failing.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <InlineNotice tone="neg" title="Not released." role="alert">
                {releaseSentence(failing)}
                <ul style={{ marginTop: 6, paddingLeft: 16 }}>{failing.map((g) => <li key={g}>{gateCopy(g).fix.label}</li>)}</ul>
              </InlineNotice>
            </div>
          )}
        </PanelSection>
      )}

      <PanelSection title="Operations" meta={`${count(done)} of ${count(data.operations.length)} done`}>
        {data.operations.length === 0 ? (
          <p className="t-cap">No operations yet. Apply a routing; standard minutes are setup plus run time × quantity.</p>
        ) : (
          <table className="ops-mini">
            <thead><tr><th>#</th><th>Operation</th><th className="n">Std</th><th className="n">Actual</th><th>Status</th>{engineering && !readOnly && <th />}</tr></thead>
            <tbody>
              {data.operations.map((x) => (
                <tr key={x.id}>
                  <td className="ops-num">{x.seq}</td>
                  <td><span className="l1">{x.name}</span><span className="l2">{center.get(x.work_center_id)?.name ?? 'Work center'}{x.is_rework ? ' · rework' : ''}{x.qty_scrap ? ` · ${x.qty_scrap} scrap` : ''}</span></td>
                  <td className="n">{x.std_minutes}</td>
                  <td className="n">{x.actual_minutes || '—'}</td>
                  <td><StatusMark mark={OP_STATUS[x.status]} /></td>
                  {engineering && !readOnly && <td>{x.status === 'PENDING' && <Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${x.name}`} onClick={() => void act('op', 'post', url, { op: 'remove_operation', operationId: x.id }, 'Removed the operation')} />}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td /><td>Total</td><td className="n">{std}</td><td className="n">{actual}</td><td colSpan={engineering && !readOnly ? 2 : 1}>{std > 0 && actual > 0 ? `${Math.round((std / actual) * 100)}% efficiency` : ''}</td></tr></tfoot>
          </table>
        )}
        {engineering && !readOnly && (
          <>
            <form className="row" style={{ gap: 8, marginTop: 12, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); if (routingId) void act('routing', 'post', url, { op: 'apply_routing', routingId, replace: data.operations.length > 0 }, 'Applied the routing'); }}>
              <Field label={data.operations.length ? 'Replace with routing' : 'Apply routing'}>
                <Select value={routingId} onChange={(e) => setRoutingId(e.target.value)}>
                  <option value="">Pick a routing</option>
                  {p.routings.filter((r) => r.is_active).map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}{r.version > 1 ? ` v${r.version}` : ''}</option>)}
                </Select>
              </Field>
              <Button type="submit" disabled={!routingId || busy === 'routing'}>{data.operations.length ? 'Replace' : 'Apply'}</Button>
            </form>
            <AddOperation centers={p.centers} busy={busy === 'op'} onAdd={(b) => act('op', 'post', url, { op: 'add_operation', ...b }, `Added ${b.name}`)} />
          </>
        )}
      </PanelSection>

      <CutList bom={data.bom} editable={engineering && !readOnly} busy={busy} onAdd={(b) => act('bom', 'post', url, { op: 'add_bom', ...b }, 'Added the part')} onRemove={(l) => void act(`bom:${l.id}`, 'post', url, { op: 'remove_bom', lineId: l.id }, 'Removed the part')} />

      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)} tone="danger" title={`Cancel ${o.number}`} confirmLabel="Cancel the order" cancelLabel="Keep it"
        reason={{ label: 'Why', minLength: 0, placeholder: 'Client cancelled the island' }}
        onConfirm={async (reason) => { const r = await act('cancel', 'post', url, { op: 'cancel', reason: reason || null }, `Cancelled ${o.number}`); if (!r) throw new Error('Not cancelled.'); }}>
        Open operations stop. Minutes already reported stay on the record.
      </ConfirmDialog>
      <ConfirmDialog open={holdOpen} onClose={() => setHoldOpen(false)} title={`Hold ${o.number}`} confirmLabel="Put on hold"
        reason={{ label: 'Waiting on', minLength: 0, placeholder: 'Hinges back-ordered' }}
        onConfirm={async (reason) => { const r = await act('hold', 'post', url, { op: 'hold', reason: reason || null }, `${o.number} on hold`); if (!r) throw new Error('Not changed.'); }}>
        The shop floor stops showing its operations as ready until you resume it.
      </ConfirmDialog>
    </Panel>
  );
}

function AddOperation({ centers, busy, onAdd }: { centers: ReadonlyArray<WorkCenterRow>; busy: boolean; onAdd: (b: { workCenterId: string; name: string; stdMinutes: number }) => Promise<unknown> }) {
  const [wc, setWc] = useState('');
  const [name, setName] = useState('');
  const [mins, setMins] = useState('');
  return (
    <form className="mp-add" style={{ marginTop: 8, padding: 12 }} onSubmit={(e) => { e.preventDefault(); const m = parseNum(mins); if (wc && name.trim() && m != null && m >= 0) void onAdd({ workCenterId: wc, name: name.trim(), stdMinutes: Math.round(m) }).then((r) => { if (r) { setName(''); setMins(''); } }); }}>
      <Field label="Work center"><Select value={wc} onChange={(e) => setWc(e.target.value)}><option value="">Pick</option>{centers.filter((c) => c.status !== 'INACTIVE').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <Field label="Operation"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Edgeband" maxLength={120} /></Field>
      <Field label="Std minutes"><Input inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value)} style={{ width: 96 }} /></Field>
      <Button type="submit" icon="plus" disabled={busy || !wc || !name.trim()}>Add</Button>
    </form>
  );
}

function mm(v: number | null): string {
  return v == null ? '' : String(Math.round(v * 10) / 10);
}

function CutList({ bom, editable, busy, onAdd, onRemove }: { bom: BomLineRow[]; editable: boolean; busy: string | null; onAdd: (b: Record<string, unknown>) => Promise<unknown>; onRemove: (l: BomLineRow) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, BomLineRow[]>();
    for (const l of bom) m.set(l.assembly_ref ?? '', [...(m.get(l.assembly_ref ?? '') ?? []), l]);
    return [...m.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })));
  }, [bom]);
  const [f, setF] = useState({ assemblyRef: '', partCode: '', description: '', material: '', qty: '1', lengthMm: '', widthMm: '', thicknessMm: '', edgeband: '', lineKind: 'PART' as BomKind, grain: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    const qty = parseNum(f.qty);
    if (!f.description.trim() || qty == null || qty <= 0) return;
    const r = await onAdd({
      lineKind: f.lineKind, partCode: f.partCode.trim() || null, description: f.description.trim(), material: f.material.trim() || null, qty,
      lengthMm: parseNum(f.lengthMm), widthMm: parseNum(f.widthMm), thicknessMm: parseNum(f.thicknessMm), grain: f.grain || null, edgeband: f.edgeband.trim() || null, assemblyRef: f.assemblyRef.trim() || null,
    });
    if (r) setF({ ...f, partCode: '', description: '', qty: '1', lengthMm: '', widthMm: '' });
  };
  return (
    <PanelSection title="Cut list and materials" meta={`${count(bom.length)} lines`}>
      {bom.length === 0 ? <p className="t-cap">No parts yet. Enter the cut list (or import it from your CAD/CAM) before release.</p> : (
        <table className="ops-mini">
          <thead><tr><th>Part</th><th>Material</th><th className="n">Qty</th><th className="n">L × W × T mm</th>{editable && <th />}</tr></thead>
          {groups.map(([ref, ls]) => (
            <tbody key={ref || 'loose'}>
              <tr><td colSpan={editable ? 5 : 4} style={{ background: 'var(--canvas)', fontWeight: 600 }}>{ref ? `Assembly ${ref}` : 'Loose parts and materials'}</td></tr>
              {ls.map((l) => (
                <tr key={l.id}>
                  <td><span className="l1">{l.part_code ? <span className="code">{l.part_code}</span> : null} {l.description}</span><span className="l2">{[BOM_KIND_WORDS[l.line_kind], l.grain && l.grain !== 'NONE' ? `grain ${l.grain.toLowerCase()}` : null, l.edgeband ? `edge ${l.edgeband}` : null].filter(Boolean).join(' · ')}</span></td>
                  <td>{l.material ?? '—'}</td>
                  <td className="n">{l.qty} {l.uom}</td>
                  <td className="n">{l.length_mm || l.width_mm ? `${mm(l.length_mm)} × ${mm(l.width_mm)}${l.thickness_mm ? ` × ${mm(l.thickness_mm)}` : ''}` : '—'}</td>
                  {editable && <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${l.description}`} disabled={busy === `bom:${l.id}`} onClick={() => onRemove(l)} /></td>}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}
      {editable && (
        <form className="mp-form" style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="mp-form-2">
            <Field label="Kind"><Select value={f.lineKind} onChange={(e) => setF({ ...f, lineKind: e.target.value as BomKind })}>{BOM_KINDS.map((k) => <option key={k} value={k}>{BOM_KIND_WORDS[k]}</option>)}</Select></Field>
            <Field label="Assembly"><Input value={f.assemblyRef} onChange={set('assemblyRef')} placeholder="B24" maxLength={40} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Part code"><Input value={f.partCode} onChange={set('partCode')} placeholder="B24-SIDE-L" maxLength={40} /></Field>
            <Field label="Description"><Input value={f.description} onChange={set('description')} placeholder="Left side" maxLength={300} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Material"><Input value={f.material} onChange={set('material')} placeholder="3/4 maple ply" maxLength={120} /></Field>
            <Field label="Quantity"><Input inputMode="decimal" value={f.qty} onChange={set('qty')} /></Field>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Field label="Length mm"><Input inputMode="decimal" value={f.lengthMm} onChange={set('lengthMm')} style={{ width: 96 }} /></Field>
            <Field label="Width mm"><Input inputMode="decimal" value={f.widthMm} onChange={set('widthMm')} style={{ width: 96 }} /></Field>
            <Field label="Thick mm"><Input inputMode="decimal" value={f.thicknessMm} onChange={set('thicknessMm')} style={{ width: 88 }} /></Field>
            <Field label="Grain"><Select value={f.grain} onChange={set('grain')}><option value="">—</option><option value="LENGTH">Length</option><option value="WIDTH">Width</option><option value="NONE">None</option></Select></Field>
          </div>
          <Field label="Edgeband"><Input value={f.edgeband} onChange={set('edgeband')} placeholder="1 long edge, maple" maxLength={60} /></Field>
          <div><Button type="submit" icon="plus" disabled={busy === 'bom' || !f.description.trim()}>Add part</Button></div>
        </form>
      )}
    </PanelSection>
  );
}
