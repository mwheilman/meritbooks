'use client';

import { useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, Input, Select, Tag, WidgetState, count, shortDate } from '@meritbooks/merit-ui';
import { AREA_KIND_WORDS, CATEGORY_WORDS_FLOOR, MEASURE_STATUS } from '@/lib/pm/ops/labels';
import { materialQty, qtyText, sqftFromDims, UOM_WORDS } from '@/lib/pm/ops/measure-math';
import type { AreaKind, MaterialUom, MeasureAreaRow, MeasureRow, MeasureTotalRow, ProductCategory } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, PctInput, Section, StatusMark, parseNum } from '../common/bits';
import { useOps } from '../common/useOps';

export interface MeasuresViewProps {
  measures: MeasureRow[];
  areas: MeasureAreaRow[];
  totals: MeasureTotalRow[];
  jobs: JobOption[];
  today: string;
  fixedJobId?: string | null;
  initialJobId?: string | null;
}

const UOMS: MaterialUom[] = ['SF', 'SY', 'BOX', 'LF', 'EA'];

/** Flooring takeoffs: rooms with square feet, waste and the material quantity to order. */
export function MeasuresView(p: MeasuresViewProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const withMeasures = useMemo(() => p.jobs.filter((j) => p.measures.some((m) => m.job_id === j.id)), [p.jobs, p.measures]);
  const [jobId, setJobId] = useState(p.fixedJobId ?? p.initialJobId ?? withMeasures[0]?.id ?? '');
  const versions = p.measures.filter((m) => m.job_id === jobId).sort((a, b) => b.version - a.version);
  const [measureId, setMeasureId] = useState<string | null>(null);
  const m = versions.find((x) => x.id === measureId) ?? versions.find((x) => x.status === 'DRAFT') ?? versions.find((x) => x.status === 'FINAL') ?? versions[0] ?? null;
  const areas = m ? p.areas.filter((a) => a.measure_id === m.id) : [];
  const final = versions.find((x) => x.status === 'FINAL') ?? null;
  const totals = final ? p.totals.filter((t) => t.measure_id === final.id) : [];
  const [finalOpen, setFinalOpen] = useState(false);

  const startVersion = (copyFromId: string | null) =>
    void act<{ measureId: string; version: number }>('start', 'post', '/api/ops/measures', { jobId, copyFromId }, (d) => `Started measure v${d.version}`).then((r) => { if (r) setMeasureId(r.measureId); });

  return (
    <div className="stack">
      <div className="ops-toolbar">
        {!p.fixedJobId && (
          <Field label={v.job}><JobSelect jobs={p.jobs.filter((j) => j.open || withMeasures.includes(j))} value={jobId} onChange={(id) => { setJobId(id); setMeasureId(null); }} /></Field>
        )}
        {versions.length > 1 && (
          <Field label="Version">
            <Select value={m?.id ?? ''} onChange={(e) => setMeasureId(e.target.value)}>
              {versions.map((x) => <option key={x.id} value={x.id}>v{x.version} · {MEASURE_STATUS[x.status].word} · {shortDate(x.measured_on, p.today)}</option>)}
            </Select>
          </Field>
        )}
        <span className="sp" />
        {!readOnly && jobId && !versions.some((x) => x.status === 'DRAFT') && (
          <Button variant="primary" icon="plus" disabled={busy === 'start'} onClick={() => startVersion(final?.id ?? null)}>{final ? 'Start a new version from the final' : 'Start the measure'}</Button>
        )}
      </div>
      <Failure text={error} />
      {!jobId ? (
        <div className="surface"><WidgetState state={{ kind: 'empty', title: `Pick the ${lower(v.job)} to measure`, body: 'Each takeoff is a version; finalize it to order material from it.' }} /></div>
      ) : !m ? (
        <div className="surface"><WidgetState state={{ kind: 'empty', title: 'No measure on this job yet', body: 'Start one, then add each room or area: dimensions or square feet, waste, and how the material is sold.' }} /></div>
      ) : (
        <>
          <Section title={`Measure v${m.version}`} meta={`${MEASURE_STATUS[m.status].word} · measured ${shortDate(m.measured_on, p.today)}`}
            actions={!readOnly && m.status === 'DRAFT' ? <Button variant="primary" disabled={areas.length === 0 || busy === 'final'} onClick={() => setFinalOpen(true)}>Finalize</Button> : <StatusMark mark={MEASURE_STATUS[m.status]} />}>
            <div className="mp-table">
              <table className="ops-mini">
                <thead><tr><th>Room or area</th><th>Product</th><th className="n">L × W ft</th><th className="n">Sq ft</th><th className="n">Waste</th><th className="n">Order</th>{m.status === 'DRAFT' && !readOnly && <th />}</tr></thead>
                <tbody>
                  {areas.length === 0 && <tr><td colSpan={7} className="t-cap">No areas yet.</td></tr>}
                  {areas.map((a) => (
                    <tr key={a.id}>
                      <td><span className="l1">{a.room_name}</span><span className="l2">{AREA_KIND_WORDS[a.area_kind]}{a.notes ? ` · ${a.notes}` : ''}</span></td>
                      <td>{a.product_category ? CATEGORY_WORDS_FLOOR[a.product_category] : '—'}</td>
                      <td className="n">{a.length_ft && a.width_ft ? `${a.length_ft} × ${a.width_ft}` : '—'}</td>
                      <td className="n">{a.material_uom === 'LF' ? `${a.linear_ft ?? 0} lf` : a.material_uom === 'EA' ? `${a.each_count ?? 0} ea` : (a.sqft ?? 0).toLocaleString('en-US')}</td>
                      <td className="n">{Math.round(a.waste_pct * 1000) / 10}%</td>
                      <td className="n b">{qtyText(a.material_qty, a.material_uom)}</td>
                      {m.status === 'DRAFT' && !readOnly && <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${a.room_name}`} onClick={() => void act('area', 'post', `/api/ops/measures/${m.id}`, { op: 'remove_area', areaId: a.id }, 'Removed the area')} /></td>}
                    </tr>
                  ))}
                </tbody>
                {areas.length > 0 && (
                  <tfoot><tr><td colSpan={3}>{count(areas.length)} areas</td><td className="n">{areas.reduce((s, a) => s + (a.sqft ?? 0), 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td><td /><td className="n">{[...new Set(areas.map((a) => a.material_uom))].map((u) => qtyText(areas.filter((a) => a.material_uom === u).reduce((s, a) => s + (a.material_qty ?? 0), 0), u)).join(' · ')}</td>{m.status === 'DRAFT' && !readOnly && <td />}</tr></tfoot>
                )}
              </table>
              {m.status === 'DRAFT' && !readOnly && <AddArea busy={busy === 'area'} onAdd={(area) => act('area', 'post', `/api/ops/measures/${m.id}`, { op: 'add_area', area }, `Added ${String(area.roomName)}`)} />}
            </div>
          </Section>
          {final && totals.length > 0 && (
            <Section title="Order from the final measure" meta={`v${final.version}`}>
              <ul className="feed feed--flush">
                {totals.map((t) => (
                  <li key={`${t.product_category}:${t.material_uom}`}>
                    <span className="l1" style={{ fontWeight: 400 }}>{t.product_category ? CATEGORY_WORDS_FLOOR[t.product_category] : 'Unassigned product'} · {count(t.areas)} areas · {(t.sqft ?? 0).toLocaleString('en-US')} sq ft</span>
                    <span className="b tnum">{qtyText(t.material_qty, t.material_uom)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {versions.filter((x) => x.status === 'SUPERSEDED').length > 0 && <p className="t-cap"><Tag>History</Tag> {versions.filter((x) => x.status === 'SUPERSEDED').length} superseded version(s) kept for the record.</p>}
        </>
      )}
      <ConfirmDialog open={finalOpen} onClose={() => setFinalOpen(false)} title={`Finalize measure v${m?.version ?? ''}`} confirmLabel="Finalize"
        onConfirm={async () => { if (!m) return; const r = await act('final', 'post', `/api/ops/measures/${m.id}`, { op: 'finalize' }, `Measure v${m.version} is final`); if (!r) throw new Error('Not finalized.'); }}>
        The quantities lock and become what material is ordered from. {final ? `v${final.version} becomes superseded.` : ''} Changes after this go in a new version.
      </ConfirmDialog>
    </div>
  );
}

function AddArea({ busy, onAdd }: { busy: boolean; onAdd: (a: Record<string, unknown>) => Promise<unknown> }) {
  const [room, setRoom] = useState('');
  const [kind, setKind] = useState<AreaKind>('FLOOR');
  const [cat, setCat] = useState<ProductCategory | ''>('');
  const [len, setLen] = useState('');
  const [wid, setWid] = useState('');
  const [sqft, setSqft] = useState('');
  const [lin, setLin] = useState('');
  const [each, setEach] = useState('');
  const [waste, setWaste] = useState<number | null>(0.1);
  const [uom, setUom] = useState<MaterialUom>('SF');
  const [cov, setCov] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const L = parseNum(len);
  const W = parseNum(wid);
  const S = parseNum(sqft);
  const preview = materialQty({ material_uom: uom, sqft: S ?? sqftFromDims(L, W), linear_ft: parseNum(lin), each_count: parseNum(each), waste_pct: waste ?? 0, coverage_sf_per_unit: parseNum(cov) });
  const submit = async () => {
    if (!room.trim()) return setErr('Name the room or area.');
    if ((uom === 'SF' || uom === 'SY' || uom === 'BOX') && S == null && (L == null || W == null)) return setErr('Give length and width, or square feet.');
    if (uom === 'BOX' && !parseNum(cov)) return setErr('Boxes need the square feet one box covers.');
    if (uom === 'LF' && parseNum(lin) == null) return setErr('Give the linear feet.');
    if (uom === 'EA' && parseNum(each) == null) return setErr('Give the count.');
    setErr(null);
    const r = await onAdd({ roomName: room.trim(), areaKind: kind, productCategory: cat || null, lengthFt: L, widthFt: W, sqft: S, linearFt: parseNum(lin), eachCount: parseNum(each), wastePct: waste ?? 0, materialUom: uom, coverageSfPerUnit: parseNum(cov) });
    if (r) { setRoom(''); setLen(''); setWid(''); setSqft(''); setLin(''); setEach(''); }
  };
  return (
    <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void submit(); }} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Room or area" error={err ?? undefined}><Input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Living room" maxLength={120} style={{ width: 180 }} /></Field>
        <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value as AreaKind)}>{(Object.keys(AREA_KIND_WORDS) as AreaKind[]).map((k) => <option key={k} value={k}>{AREA_KIND_WORDS[k]}</option>)}</Select></Field>
        <Field label="Product"><Select value={cat} onChange={(e) => setCat(e.target.value as ProductCategory | '')}><option value="">—</option>{(Object.keys(CATEGORY_WORDS_FLOOR) as ProductCategory[]).map((k) => <option key={k} value={k}>{CATEGORY_WORDS_FLOOR[k]}</option>)}</Select></Field>
        <Field label="Sold by"><Select value={uom} onChange={(e) => setUom(e.target.value as MaterialUom)}>{UOMS.map((u) => <option key={u} value={u}>{UOM_WORDS[u]}</option>)}</Select></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {(uom === 'SF' || uom === 'SY' || uom === 'BOX') && (
          <>
            <Field label="Length ft"><Input inputMode="decimal" value={len} onChange={(e) => setLen(e.target.value)} style={{ width: 88 }} /></Field>
            <Field label="Width ft"><Input inputMode="decimal" value={wid} onChange={(e) => setWid(e.target.value)} style={{ width: 88 }} /></Field>
            <Field label="or sq ft"><Input inputMode="decimal" value={sqft} onChange={(e) => setSqft(e.target.value)} style={{ width: 96 }} placeholder={L && W ? String(sqftFromDims(L, W)) : ''} /></Field>
          </>
        )}
        {uom === 'BOX' && <Field label="Sq ft a box"><Input inputMode="decimal" value={cov} onChange={(e) => setCov(e.target.value)} style={{ width: 96 }} /></Field>}
        {uom === 'LF' && <Field label="Linear ft"><Input inputMode="decimal" value={lin} onChange={(e) => setLin(e.target.value)} style={{ width: 96 }} /></Field>}
        {uom === 'EA' && <Field label="Count"><Input inputMode="decimal" value={each} onChange={(e) => setEach(e.target.value)} style={{ width: 88 }} /></Field>}
        <Field label="Waste"><PctInput value={waste} onChange={setWaste} placeholder="10" /></Field>
        <span className="t-cap" style={{ paddingBottom: 8 }}>Order <b className="tnum">{qtyText(preview, uom)}</b></span>
        <Button type="submit" icon="plus" disabled={busy}>Add area</Button>
      </div>
    </form>
  );
}
