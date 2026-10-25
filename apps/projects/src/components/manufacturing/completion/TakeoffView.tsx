'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, ButtonRow, Field, InlineNotice, Input, Seg, Select, WidgetState, count } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { openPdf, renderToCanvas } from '@/components/documents/pdf/pdfjs';
import { calibrate, takeoffQty, toFraction, uomFor, type Pt, type ScaleUnit, type TakeoffKind } from '@/lib/mfg/takeoff';
import type { Opt } from '@/components/dealer/completion/kit';

interface SheetRow { sheet_id: string; sheet_number: string; title: string | null; revision_id: string; revision_label: string | null; set: string; issued_on: string | null }
interface SheetDetail { revisions: Array<{ id: string; is_current: boolean; url: string | null; width_pt: number | null; height_pt: number | null }> }
interface Takeoff { id: string; kind: TakeoffKind; label: string; room: string | null; points: Pt[]; qty: number; uom: string; product_id: string | null; estimate_line_id: string | null; wbs_id: string | null }
interface Sheet { revision_id: string; width_pt: number | null; height_pt: number | null; is_current: boolean; scale: { unit: ScaleUnit; pts_per_unit: number; p1: Pt; p2: Pt; known_length: number } | null; takeoffs: Takeoff[] }
interface SummaryRow { room: string | null; kind: string; label: string; uom: string; qty: number; count: number; product: string | null; in_estimate: boolean }

type Tool = 'LINEAR' | 'AREA' | 'COUNT' | 'SCALE';
const COLORS: Record<TakeoffKind, string> = { LINEAR: '#2563EB', AREA: '#1F6E50', COUNT: '#B42318' };

/** Measure runs, wall areas and counts straight off the current drawing sheet; the database measures them again at the sheet's scale. */
export function TakeoffView({ jobs, areas, products, estimates }: { jobs: Opt[]; areas: Array<Opt & { jobId: string }>; products: Opt[]; estimates: Array<Opt & { jobId: string }> }) {
  const { readOnly } = useShell();
  const [job, setJob] = useState(jobs[0]?.id ?? '');
  const sheets = useBoard<SheetRow[]>(job ? `/api/mfg/engineering?view=sheets&job=${job}` : null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const summary = useBoard<SummaryRow[]>(job ? `/api/mfg/front?view=takeoff_summary&job=${job}` : null);
  const cur = sheets.data?.find((s) => s.sheet_id === sheetId) ?? null;
  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Field label="Job"><Select value={job} onChange={(e) => { setJob(e.target.value); setSheetId(null); }}>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}</Select></Field>
        {sheets.data && <Field label="Sheet"><Select value={sheetId ?? ''} onChange={(e) => setSheetId(e.target.value || null)}><option value="">Pick a sheet</option>{sheets.data.map((s) => <option key={s.sheet_id} value={s.sheet_id}>{s.sheet_number}{s.title ? ` · ${s.title}` : ''} (rev {s.revision_label ?? '—'})</option>)}</Select></Field>}
      </div>
      {job && <BoardState b={sheets} what="Drawing sheets" />}
      {sheets.data && sheets.data.length === 0 && <Empty title="No drawings on this job" body="Upload the drawing set on the job's Documents; takeoff works on its current sheets." />}
      {cur && <SheetTakeoff key={cur.revision_id} sheetId={cur.sheet_id} revisionId={cur.revision_id} readOnly={readOnly} areas={areas.filter((a) => a.jobId === job)} products={products} estimates={estimates.filter((e) => e.jobId === job)} onChange={summary.reload} />}
      {summary.data && summary.data.length > 0 && (
        <Section title="Takeoff by room" meta="Every sheet on the job">
          <table className="ops-mini" aria-label="Takeoff summary"><thead><tr><th>Room</th><th>Item</th><th className="n">Quantity</th><th>Priced</th></tr></thead>
            <tbody>{summary.data.map((r, i) => <tr key={i}><td>{r.room ?? '—'}</td><td>{r.label}{r.product ? <div className="t-cap">{r.product}</div> : null}</td><td className="n">{qty(r.qty, r.uom)}{r.count > 1 ? <div className="t-cap">{count(r.count)} takeoffs</div> : null}</td><td>{r.in_estimate ? 'on the estimate' : '—'}</td></tr>)}</tbody></table>
        </Section>
      )}
    </div>
  );
}

function SheetTakeoff({ sheetId, revisionId, readOnly, areas, products, estimates, onChange }: { sheetId: string; revisionId: string; readOnly: boolean; areas: Opt[]; products: Opt[]; estimates: Opt[]; onChange: () => void }) {
  const detail = useBoard<SheetDetail>(`/api/documents/drawings/sheets/${sheetId}`);
  const s = useBoard<Sheet>(`/api/mfg/front?view=takeoff&revision=${revisionId}`);
  const { run, busy, error } = useDo(() => { s.reload(); onChange(); });
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [renderErr, setRenderErr] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('LINEAR');
  const [pts, setPts] = useState<Pt[]>([]);
  const [meta, setMeta] = useState({ label: '', room: '', wbsId: '', productId: '' });
  const [cal, setCal] = useState({ len: '', unit: 'FT' as ScaleUnit });
  const [price, setPrice] = useState<{ takeoffId: string; estimateId: string; w: string; h: string; d: string } | null>(null);
  const rev = detail.data?.revisions.find((r) => r.id === revisionId) ?? null;

  useEffect(() => {
    let dead = false;
    if (!rev?.url || !canvas.current || !box.current) return;
    const width = Math.min(box.current.clientWidth || 900, 1400);
    openPdf(rev.url).then((doc) => renderToCanvas(doc, canvas.current!, width)).then((r) => { if (!dead) setSize({ w: r.width, h: r.height }); }).catch(() => { if (!dead) setRenderErr('This sheet could not be drawn here. Open it on Documents.'); });
    return () => { dead = true; };
  }, [rev?.url]);

  const page = s.data?.width_pt && s.data.height_pt ? { width: Number(s.data.width_pt), height: Number(s.data.height_pt) } : null;
  const scale = s.data?.scale ?? null;
  const preview = page && scale && pts.length && tool !== 'SCALE' ? takeoffQty(tool, pts, page, Number(scale.pts_per_unit), scale.unit) : null;

  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    if (readOnly) return;
    const p = toFraction(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    if (tool === 'SCALE' && pts.length >= 2) setPts([p]); else setPts([...pts, p]);
  };
  const save = async () => {
    if (tool === 'SCALE') {
      if (pts.length !== 2 || !(Number(cal.len) > 0)) return;
      await run('scale', '/api/mfg/front', { op: 'set_scale', revisionId, p1: pts[0], p2: pts[1], knownLength: Number(cal.len), unit: cal.unit }, 'Scale set; takeoffs re-measured');
      setPts([]); setTool('LINEAR');
      return;
    }
    const r = await run('save', '/api/mfg/front', { op: 'save_takeoff', revisionId, kind: tool, points: pts, label: meta.label || null, room: meta.room || null, wbsId: meta.wbsId || null, productId: meta.productId || null }, (d: { qty: number; uom: string }) => `${qty(d.qty, d.uom)} saved`);
    if (r) setPts([]);
  };
  const W = size?.w ?? 0;
  const H = size?.h ?? 0;
  const poly = (p: readonly Pt[]) => p.map(([x, y]) => `${x * W},${y * H}`).join(' ');
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={s} what="The sheet's takeoff" />
      {s.data && !s.data.is_current && <InlineNotice tone="warn" title="Superseded revision.">This is not the current sheet; take off from the current set.</InlineNotice>}
      {s.data && !page && <InlineNotice tone="warn" title="No page size on this sheet.">Open the sheet once on Documents so its size is recorded, then take off here.</InlineNotice>}
      {!readOnly && (
        <div className="ops-toolbar">
          <Seg aria-label="Tool" value={tool} onChange={(v) => { setTool(v as Tool); setPts([]); }} items={[{ value: 'LINEAR', label: 'Run (LF)' }, { value: 'AREA', label: 'Area (SF)' }, { value: 'COUNT', label: 'Count' }, { value: 'SCALE', label: scale ? 'Re-scale' : 'Set scale' }]} />
          {tool === 'SCALE' ? <>
            <Field label="Real length between the two points"><Input inputMode="decimal" value={cal.len} onChange={(e) => setCal({ ...cal, len: e.target.value })} style={{ width: 90 }} /></Field>
            <Field label="Unit"><Select value={cal.unit} onChange={(e) => setCal({ ...cal, unit: e.target.value as ScaleUnit })}><option value="FT">ft</option><option value="IN">in</option><option value="M">m</option><option value="MM">mm</option></Select></Field>
            {page && pts.length === 2 && Number(cal.len) > 0 && <span className="t-cap">{(calibrate(pts[0]!, pts[1]!, Number(cal.len), page)).toFixed(2)} pt per {cal.unit.toLowerCase()}</span>}
          </> : <>
            <Field label="Label"><Input value={meta.label} onChange={(e) => setMeta({ ...meta, label: e.target.value })} placeholder="Base run" style={{ width: 130 }} /></Field>
            <Field label="Room"><Input value={meta.room} onChange={(e) => setMeta({ ...meta, room: e.target.value })} style={{ width: 110 }} /></Field>
            <Field label="Area"><Select value={meta.wbsId} onChange={(e) => setMeta({ ...meta, wbsId: e.target.value })}><option value="">—</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select></Field>
            <Field label="Product"><Select value={meta.productId} onChange={(e) => setMeta({ ...meta, productId: e.target.value })}><option value="">—</option>{products.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select></Field>
          </>}
          <ButtonRow>
            <Button variant="primary" disabled={busy != null || (tool === 'SCALE' ? pts.length !== 2 : tool === 'COUNT' ? pts.length < 1 : tool === 'AREA' ? pts.length < 3 : pts.length < 2) || (tool !== 'COUNT' && tool !== 'SCALE' && !scale)} onClick={() => void save()}>{tool === 'SCALE' ? 'Set the scale' : 'Save'}</Button>
            <Button variant="quiet" disabled={!pts.length} onClick={() => setPts(pts.slice(0, -1))}>Undo point</Button>
          </ButtonRow>
          {preview != null && <span className="t-cap">{qty(preview, uomFor(tool as TakeoffKind, scale!.unit))}</span>}
          {!scale && tool !== 'SCALE' && tool !== 'COUNT' && <span className="t-cap">Set the scale first: click two points of a known dimension.</span>}
        </div>
      )}
      <div ref={box} style={{ position: 'relative', width: '100%', overflow: 'auto' }}>
        {detail.isLoading && !size && <WidgetState state={{ kind: 'loading', label: 'Drawing the sheet…', lines: 4 }} />}
        {renderErr && <p className="neg t-cap">{renderErr}</p>}
        <canvas ref={canvas} aria-label="Drawing sheet" />
        {size && (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', left: 0, top: 0, cursor: readOnly ? 'default' : 'crosshair' }} onClick={click} role="img" aria-label="Takeoff overlay: click to place points">
            {s.data?.takeoffs.map((t) => t.kind === 'COUNT'
              ? t.points.map(([x, y], i) => <circle key={`${t.id}-${i}`} cx={x * W} cy={y * H} r={6} fill="none" stroke={COLORS.COUNT} strokeWidth={2} />)
              : t.kind === 'AREA' ? <polygon key={t.id} points={poly(t.points)} fill={COLORS.AREA} fillOpacity={0.15} stroke={COLORS.AREA} strokeWidth={2} />
              : <polyline key={t.id} points={poly(t.points)} fill="none" stroke={COLORS.LINEAR} strokeWidth={3} />)}
            {scale && <line x1={scale.p1[0] * W} y1={scale.p1[1] * H} x2={scale.p2[0] * W} y2={scale.p2[1] * H} stroke="#8494A7" strokeDasharray="6 4" strokeWidth={2} />}
            {pts.length > 0 && (tool === 'COUNT' ? pts.map(([x, y], i) => <circle key={i} cx={x * W} cy={y * H} r={6} fill="#B42318" fillOpacity={0.4} />)
              : tool === 'AREA' ? <polygon points={poly(pts)} fill="#1F6E50" fillOpacity={0.25} stroke="#1F6E50" strokeDasharray="4 3" strokeWidth={2} />
              : <polyline points={poly(pts)} fill="none" stroke={tool === 'SCALE' ? '#8494A7' : '#2563EB'} strokeDasharray="4 3" strokeWidth={3} />)}
            {pts.map(([x, y], i) => <circle key={`p${i}`} cx={x * W} cy={y * H} r={3} fill="#0A1628" />)}
          </svg>
        )}
      </div>
      {s.data && (
        <Section title={`${count(s.data.takeoffs.length)} takeoffs on this sheet`} meta={scale ? `Scale: ${Number(scale.known_length)} ${scale.unit.toLowerCase()} calibrated` : 'No scale yet'}>
          {s.data.takeoffs.length === 0 ? <p className="t-cap">Pick a tool and click on the sheet.</p> : (
            <table className="ops-mini" aria-label="Takeoffs">
              <thead><tr><th>Item</th><th>Room</th><th className="n">Quantity</th><th><span className="sr">Actions</span></th></tr></thead>
              <tbody>{s.data.takeoffs.map((t) => <tr key={t.id}><td>{t.label}</td><td>{t.room ?? '—'}</td><td className="n">{qty(t.qty, t.uom)}</td>
                <td>{!readOnly && <ButtonRow>
                  {!t.estimate_line_id && t.product_id && estimates.length > 0 && <Button variant="quiet" onClick={() => setPrice({ takeoffId: t.id, estimateId: estimates[0]!.id, w: t.uom === 'LF' ? String(Math.round(Number(t.qty) * 12)) : '', h: '', d: '' })}>Price it</Button>}
                  <Button variant="quiet" disabled={busy === t.id} onClick={() => void run(t.id, '/api/mfg/front', { op: 'delete_takeoff', id: t.id }, 'Removed')}>Remove</Button>
                </ButtonRow>}{t.estimate_line_id && <span className="t-cap">priced</span>}</td></tr>)}</tbody>
            </table>
          )}
          {price && (
            <ButtonRow>
              <Select aria-label="Estimate" value={price.estimateId} onChange={(e) => setPrice({ ...price, estimateId: e.target.value })}>{estimates.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>
              <Field label="Width (in)"><Input inputMode="decimal" value={price.w} onChange={(e) => setPrice({ ...price, w: e.target.value })} style={{ width: 80 }} /></Field>
              <Button variant="primary" disabled={busy === 'price'} onClick={() => { const t = s.data!.takeoffs.find((x) => x.id === price.takeoffId)!; void run('price', '/api/mfg/front', { op: 'add_product_line', estimateId: price.estimateId, productId: t.product_id, takeoffId: t.id, wbsId: t.wbs_id, params: { ...(price.w ? { w: Number(price.w) } : {}), qty: t.uom === 'EA' ? Number(t.qty) : 1 } }, 'Priced on the estimate').then(() => setPrice(null)); }}>Add to the estimate</Button>
              <Button variant="quiet" onClick={() => setPrice(null)}>Cancel</Button>
            </ButtonRow>
          )}
        </Section>
      )}
    </div>
  );
}
