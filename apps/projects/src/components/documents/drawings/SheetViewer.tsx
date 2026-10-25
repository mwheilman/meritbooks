'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Check, Field, InlineNotice, Seg, Select, Status, Tag, Textarea, WidgetState, api, toast, useEscapeKey } from '@meritbooks/merit-ui';
import type { DrawingRevisionRow, MarkupKind, MarkupRow } from '@/lib/documents/types';
import type { SheetDetail } from '@/lib/documents/drawings';
import { useShell } from '@/components/shell/ShellContext';
import { openPdf, renderToCanvas } from '../pdf/pdfjs';
import { day, when } from '../client';

type Rev = SheetDetail['revisions'][number];
type Tool = 'select' | MarkupKind;
type Color = 'neg' | 'electric' | 'warn' | 'ink' | 'pos';
interface Size { w: number; h: number }
type Draft = { kind: MarkupKind; geometry: Record<string, unknown> } | null;

const COLOR_VAR: Record<Color, string> = { neg: 'var(--neg)', electric: 'var(--electric)', warn: 'var(--warn)', ink: 'var(--ink)', pos: 'var(--pos)' };
const TOOLS: Array<{ value: Tool; label: string }> = [
  { value: 'select', label: 'Select' }, { value: 'pin', label: 'Pin' }, { value: 'rect', label: 'Box' }, { value: 'cloud', label: 'Cloud' },
  { value: 'arrow', label: 'Arrow' }, { value: 'freehand', label: 'Pen' }, { value: 'text', label: 'Text' },
];

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const num = (g: Record<string, unknown>, k: string) => Number(g[k] ?? 0);

/** Tint a rendered sheet: ink → one colour, paper stays white, so a multiply overlay shows A-only / B-only / both. */
function tint(canvas: HTMLCanvasElement, rgb: [number, number, number]): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const ink = 1 - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    d[i] = 255 - ink * (255 - rgb[0]);
    d[i + 1] = 255 - ink * (255 - rgb[1]);
    d[i + 2] = 255 - ink * (255 - rgb[2]);
  }
  ctx.putImageData(img, 0, 0);
}

function cloudPath(x: number, y: number, w: number, h: number): string {
  const r = Math.max(6, Math.min(14, Math.min(w, h) / 6));
  const seg = (x1: number, y1: number, x2: number, y2: number) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(1, Math.round(len / (r * 2)));
    let p = '';
    for (let i = 1; i <= n; i++) p += ` A ${r} ${r} 0 0 1 ${x1 + ((x2 - x1) * i) / n} ${y1 + ((y2 - y1) * i) / n}`;
    return p;
  };
  return `M ${x} ${y}${seg(x, y, x + w, y)}${seg(x + w, y, x + w, y + h)}${seg(x + w, y + h, x, y + h)}${seg(x, y + h, x, y)} Z`;
}

function Shape({ m, size, selected, mine, onPick, index }: { m: { kind: MarkupKind; geometry: Record<string, unknown>; style?: Record<string, unknown>; body?: string | null; visibility?: string }; size: Size; selected: boolean; mine: boolean; onPick?: () => void; index?: number }) {
  const color = COLOR_VAR[(m.style?.color as Color) ?? 'neg'] ?? COLOR_VAR.neg;
  const sw = Number(m.style?.width ?? 2) + (selected ? 1.5 : 0);
  const dash = m.visibility === 'personal' ? '6 4' : undefined;
  const g = m.geometry;
  const common = { stroke: color, strokeWidth: sw, fill: 'none', strokeDasharray: dash, onPointerDown: onPick ? (e: React.PointerEvent) => { e.stopPropagation(); onPick(); } : undefined, style: { cursor: onPick ? 'pointer' : undefined } };
  const X = (k: string) => num(g, k) * size.w;
  const Y = (k: string) => num(g, k) * size.h;
  switch (m.kind) {
    case 'pin':
      return (
        <g {...common} fill={color}>
          <circle cx={X('x')} cy={Y('y')} r={selected ? 11 : 9} stroke="var(--white)" strokeWidth={2} />
          {index !== undefined && <text x={X('x')} y={Y('y') + 4} textAnchor="middle" fontSize={11} fill="var(--white)" stroke="none" fontWeight={700}>{index}</text>}
        </g>
      );
    case 'rect':
      return <rect {...common} x={X('x')} y={Y('y')} width={num(g, 'w') * size.w} height={num(g, 'h') * size.h} />;
    case 'cloud':
      return <path {...common} d={cloudPath(X('x'), Y('y'), num(g, 'w') * size.w, num(g, 'h') * size.h)} />;
    case 'arrow': {
      const x1 = X('x1'); const y1 = Y('y1'); const x2 = X('x2'); const y2 = Y('y2');
      const a = Math.atan2(y2 - y1, x2 - x1);
      const hl = 12;
      return (
        <g {...common}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} />
          <polyline points={`${x2 - hl * Math.cos(a - 0.45)},${y2 - hl * Math.sin(a - 0.45)} ${x2},${y2} ${x2 - hl * Math.cos(a + 0.45)},${y2 - hl * Math.sin(a + 0.45)}`} />
        </g>
      );
    }
    case 'freehand': {
      const pts = (Array.isArray(g.points) ? g.points : []) as Array<[number, number]>;
      return <polyline {...common} strokeLinejoin="round" strokeLinecap="round" points={pts.map(([x, y]) => `${x * size.w},${y * size.h}`).join(' ')} />;
    }
    case 'text':
      return (
        <g onPointerDown={common.onPointerDown} style={common.style}>
          <text x={X('x')} y={Y('y')} fontSize={14} fill={color} fontWeight={600} stroke="var(--white)" strokeWidth={3} paintOrder="stroke">{m.body ?? ''}</text>
          {selected && <circle cx={X('x')} cy={Y('y')} r={3} fill={color} />}
        </g>
      );
  }
}

export function SheetViewer({ detail, userId, canCreate, canEdit }: { detail: SheetDetail; userId: string; canCreate: boolean; canEdit: boolean }) {
  const { readOnly } = useShell();
  const revs = detail.revisions;
  const current = revs.find((r) => r.is_current) ?? revs[0] ?? null;
  const [revId, setRevId] = useState<string | null>(current?.id ?? null);
  const [cmpId, setCmpId] = useState<string>('');
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState<Color>('neg');
  const [publishNew, setPublishNew] = useState(false);
  const [layers, setLayers] = useState({ mine: true, published: true });
  const [markups, setMarkups] = useState<MarkupRow[]>([]);
  const [loadingMarks, setLoadingMarks] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [pendingText, setPendingText] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState('');
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [pdfFailed, setPdfFailed] = useState(false);
  const [rendering, setRendering] = useState(true);
  const stage = useRef<HTMLDivElement | null>(null);
  const canvasA = useRef<HTMLCanvasElement | null>(null);
  const canvasB = useRef<HTMLCanvasElement | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const rev: Rev | null = revs.find((r) => r.id === revId) ?? null;
  const cmp: Rev | null = revs.find((r) => r.id === cmpId) ?? null;
  const editable = !readOnly && canCreate && !pdfFailed;

  useEscapeKey(() => { setDraft(null); setPendingText(null); setSel(null); setTool('select'); });

  // render the sheet (and the comparison) whenever the revision, comparison or width changes
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!rev?.url || !canvasA.current || !stage.current) return;
      setRendering(true);
      try {
        const width = Math.max(600, Math.min(2400, stage.current.clientWidth - 40));
        const a = await openPdf(rev.url);
        const r = await renderToCanvas(a, canvasA.current, width);
        await a.destroy();
        if (cancelled) return;
        if (cmp?.url && canvasB.current) {
          const b = await openPdf(cmp.url);
          await renderToCanvas(b, canvasB.current, width);
          await b.destroy();
          tint(canvasA.current, [180, 35, 24]);      // this revision: brick
          tint(canvasB.current, [37, 99, 235]);      // compared: electric
        }
        setSize({ w: r.width, h: r.height });
        setPdfFailed(false);
      } catch {
        if (!cancelled) setPdfFailed(true);
      } finally {
        if (!cancelled) setRendering(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [rev?.url, cmp?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMarks = useCallback(async () => {
    if (!revId) return;
    setLoadingMarks(true);
    const r = await api.get<{ markups: MarkupRow[] }>(`/api/documents/drawings/revisions/${revId}/markups`);
    setLoadingMarks(false);
    if (r.error) { toast.error(r.error.error); return; }
    setMarkups(r.data?.markups ?? []);
  }, [revId]);
  useEffect(() => { void loadMarks(); setSel(null); }, [loadMarks]);

  const visible = useMemo(() => markups.filter((m) => (m.author_user === userId && m.visibility === 'personal' ? layers.mine : m.visibility === 'published' ? layers.published : layers.mine)), [markups, layers, userId]);
  const selected = markups.find((m) => m.id === sel) ?? null;

  const point = (e: React.PointerEvent): { x: number; y: number } => {
    const r = svg.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  const save = async (kind: MarkupKind, geometry: Record<string, unknown>, body?: string) => {
    if (!revId) return;
    const r = await api.post<{ markup: MarkupRow }>(`/api/documents/drawings/revisions/${revId}/markups`, {
      kind, geometry, body: body ?? null, style: { color, width: 2 }, visibility: publishNew && canEdit ? 'published' : 'personal',
    });
    if (r.error) { toast.error(r.error.error); return; }
    if (r.data) { setMarkups((m) => [...m, r.data!.markup]); setSel(r.data.markup.id); }
    toast(publishNew && canEdit ? 'Published the markup' : 'Saved a personal markup');
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editable || tool === 'select') { setSel(null); return; }
    const p = point(e);
    if (tool === 'pin') { void save('pin', p); return; }
    if (tool === 'text') { setPendingText(p); setText(''); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = p;
    setDraft(tool === 'freehand' ? { kind: 'freehand', geometry: { points: [[p.x, p.y]] } } : tool === 'arrow' ? { kind: 'arrow', geometry: { x1: p.x, y1: p.y, x2: p.x, y2: p.y } } : { kind: tool, geometry: { x: p.x, y: p.y, w: 0, h: 0 } });
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draft || !start.current) return;
    const p = point(e);
    const s = start.current;
    if (draft.kind === 'freehand') {
      const pts = draft.geometry.points as Array<[number, number]>;
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p.x - last[0], p.y - last[1]) > 0.002) setDraft({ kind: 'freehand', geometry: { points: [...pts, [p.x, p.y]].slice(0, 2000) } });
    } else if (draft.kind === 'arrow') setDraft({ kind: 'arrow', geometry: { x1: s.x, y1: s.y, x2: p.x, y2: p.y } });
    else setDraft({ kind: draft.kind, geometry: { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) } });
  };
  const onUp = () => {
    const d = draft;
    setDraft(null);
    start.current = null;
    if (!d) return;
    const g = d.geometry;
    const tiny = d.kind === 'freehand' ? (g.points as unknown[]).length < 2 : d.kind === 'arrow' ? Math.hypot(num(g, 'x2') - num(g, 'x1'), num(g, 'y2') - num(g, 'y1')) < 0.01 : num(g, 'w') < 0.005 || num(g, 'h') < 0.005;
    if (!tiny) void save(d.kind, g);
  };

  const act = async (url: string, method: 'patch' | 'delete', body: unknown, ok: string) => {
    const r = method === 'delete' ? await api.delete(url) : await api.patch(url, body);
    if (r.error) { toast.error(r.error.error); return false; }
    toast(ok);
    await loadMarks();
    return true;
  };

  if (!rev) return <WidgetState state={{ kind: 'empty', title: 'This sheet has no revisions yet' }} />;
  const superseded = !rev.is_current && current && current.id !== rev.id;
  let pinNo = 0;

  return (
    <div className="dwg-viewer">
      <div>
        <div className="dwg-tools">
          {editable && <Seg<Tool> aria-label="Markup tool" value={tool} onChange={(t) => { setTool(t); setSel(null); }} items={TOOLS} />}
          {editable && tool !== 'select' && (
            <Select aria-label="Colour" value={color} onChange={(e) => setColor(e.target.value as Color)} style={{ width: 110 }}>
              <option value="neg">Red</option><option value="electric">Blue</option><option value="warn">Amber</option><option value="ink">Black</option><option value="pos">Green</option>
            </Select>
          )}
          {editable && canEdit && tool !== 'select' && <Check label="Publish to the job" checked={publishNew} onChange={(e) => setPublishNew(e.target.checked)} />}
          <span style={{ flex: 1 }} />
          {rev.url && <a className="btn btn--quiet" href={rev.url} target="_blank" rel="noreferrer">Download PDF</a>}
        </div>
        {superseded && <InlineNotice tone="warn" title="You are looking at an older revision.">The current sheet is {current?.set_name}{current?.revision_label ? ` rev ${current.revision_label}` : ''}. <button type="button" className="btn btn--quiet" onClick={() => setRevId(current!.id)}>Open current</button></InlineNotice>}
        {rev.status === 'review' && <InlineNotice title="This revision is in a set under review.">It becomes current when the set is published.</InlineNotice>}
        <div className="dwg-stage" ref={stage}>
          {pdfFailed ? (
            <div style={{ padding: 16 }}>
              <InlineNotice tone="warn" title="This browser could not draw the sheet.">Markups need the built-in viewer. The PDF is shown below.</InlineNotice>
              {rev.url && <iframe title={detail.sheet.sheet_number} src={rev.url} style={{ width: '100%', height: '70dvh', border: 0, marginTop: 8 }} />}
            </div>
          ) : (
            <div className="sheet" style={{ width: size.w || undefined, height: size.h || undefined }}>
              <canvas ref={canvasA} aria-label={`Sheet ${detail.sheet.sheet_number}`} role="img" />
              {cmp && <canvas ref={canvasB} className="cmp" aria-hidden="true" />}
              {size.w > 0 && (
                <svg ref={svg} className={editable && tool !== 'select' ? 'drawing' : undefined} viewBox={`0 0 ${size.w} ${size.h}`}
                  onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} aria-label="Markups">
                  {visible.map((m) => <Shape key={m.id} m={m} size={size} selected={m.id === sel} mine={m.author_user === userId} index={m.kind === 'pin' ? ++pinNo : undefined} onPick={tool === 'select' ? () => setSel(m.id) : undefined} />)}
                  {draft && <Shape m={{ ...draft, style: { color }, visibility: publishNew ? 'published' : 'personal' }} size={size} selected={false} mine />}
                </svg>
              )}
              {rendering && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}><span className="t-cap">Drawing the sheet…</span></div>}
            </div>
          )}
        </div>
        {cmp && <div className="dwg-legend"><span><span className="a">Red</span> only on {rev.set_name}{rev.revision_label ? ` rev ${rev.revision_label}` : ''}</span><span><span className="b">Blue</span> only on {cmp.set_name}{cmp.revision_label ? ` rev ${cmp.revision_label}` : ''}</span><span>Dark = unchanged</span></div>}
        {pendingText && (
          <form className="mp-form" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void save('text', pendingText, text.trim()); setPendingText(null); } }}>
            <Field label="Note text"><Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={300} rows={2} autoFocus /></Field>
            <div className="btn-row"><Button variant="quiet" onClick={() => setPendingText(null)}>Cancel</Button><Button type="submit" variant="primary" disabled={!text.trim()}>Place note</Button></div>
          </form>
        )}
      </div>

      <aside className="stack">
        <div className="ops-section">
          <div className="ops-section-h"><h2 className="t-section">Revisions</h2></div>
          <Field label="Showing">
            <Select value={revId ?? ''} onChange={(e) => { setRevId(e.target.value); if (e.target.value === cmpId) setCmpId(''); }}>
              {revs.map((r) => <option key={r.id} value={r.id}>{r.set_name}{r.revision_label ? ` · rev ${r.revision_label}` : ''}{r.is_current ? ' · current' : r.status === 'review' ? ' · in review' : ' · superseded'}</option>)}
            </Select>
          </Field>
          {revs.length > 1 && (
            <Field label="Overlay compare with" help="Red = only on the one showing, blue = only on the other">
              <Select value={cmpId} onChange={(e) => setCmpId(e.target.value)}>
                <option value="">No comparison</option>
                {revs.filter((r) => r.id !== revId).map((r) => <option key={r.id} value={r.id}>{r.set_name}{r.revision_label ? ` · rev ${r.revision_label}` : ''}{r.issued_on ? ` · ${day(r.issued_on)}` : ''}</option>)}
              </Select>
            </Field>
          )}
          <p className="t-cap">{rev.title ?? detail.sheet.title ?? ''}{rev.issued_on ? ` · issued ${day(rev.issued_on)}` : ''}</p>
        </div>
        <div className="ops-section">
          <div className="ops-section-h"><h2 className="t-section">Markups</h2><span className="t-cap">{loadingMarks ? 'loading…' : `${visible.length} shown`}</span></div>
          <div className="btn-row">
            <Check label="Mine (personal)" checked={layers.mine} onChange={(e) => setLayers((l) => ({ ...l, mine: e.target.checked }))} />
            <Check label="Published" checked={layers.published} onChange={(e) => setLayers((l) => ({ ...l, published: e.target.checked }))} />
          </div>
          {markups.length === 0 ? <p className="t-cap">{editable ? 'Pick a tool above and draw on the sheet. Personal markups are yours alone until you publish them.' : 'No markups on this revision.'}</p> : (
            <ul className="dwg-marks">
              {markups.map((m) => (
                <li key={m.id}>
                  <button type="button" className="btn btn--quiet" style={{ justifyContent: 'flex-start' }} onClick={() => setSel(m.id)} aria-pressed={m.id === sel}>
                    {m.kind === 'freehand' ? 'Pen' : m.kind.charAt(0).toUpperCase() + m.kind.slice(1)}{m.body ? `: ${m.body.slice(0, 40)}` : ''}
                  </button>
                  <span>{m.visibility === 'published' ? <Tag tone="ai">Published</Tag> : <Tag>Personal</Tag>}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selected && (
          <div className="ops-section">
            <div className="ops-section-h"><h2 className="t-section">Selected</h2></div>
            <p className="t-cap">{selected.author_user === userId ? 'Yours' : 'A teammate’s'} · {when(selected.created_at)}{selected.published_at ? ` · published ${when(selected.published_at)}` : ''}</p>
            <MarkupNote key={selected.id} m={selected} canWrite={!readOnly && ((selected.author_user === userId && selected.visibility === 'personal') || canEdit)} onSave={(body) => void act(`/api/documents/drawings/markups/${selected.id}`, 'patch', { body }, 'Saved the note')} />
            <div className="btn-row" style={{ marginTop: 8 }}>
              {!readOnly && canEdit && (selected.visibility === 'personal' ? selected.author_user === userId : true) && (
                <Button onClick={() => void act(`/api/documents/drawings/markups/${selected.id}`, 'patch', { publish: selected.visibility === 'personal' }, selected.visibility === 'personal' ? 'Published' : 'Made personal')}>
                  {selected.visibility === 'personal' ? 'Publish to the job' : 'Unpublish'}
                </Button>
              )}
              {!readOnly && ((selected.author_user === userId && selected.visibility === 'personal') || canEdit) && (
                <Button variant="quiet" onClick={() => void act(`/api/documents/drawings/markups/${selected.id}`, 'delete', null, 'Removed the markup').then((ok) => ok && setSel(null))}>Remove</Button>
              )}
            </div>
          </div>
        )}
        <Status kind={rev.is_current ? 'ready' : 'track'} pip={rev.is_current ? 'closed' : 'open'}>{rev.is_current ? 'Current revision' : rev.status === 'review' ? 'In review' : 'Superseded'}</Status>
        <Link className="t-cap" href={`/documents/drawings/sets/${rev.set_id}`}>Open the set {rev.set_name}</Link>
      </aside>
    </div>
  );
}

function MarkupNote({ m, canWrite, onSave }: { m: MarkupRow; canWrite: boolean; onSave: (body: string | null) => void }) {
  const [v, setV] = useState(m.body ?? '');
  if (!canWrite) return m.body ? <p>{m.body}</p> : null;
  return (
    <form className="mp-form" onSubmit={(e) => { e.preventDefault(); onSave(v.trim() || null); }}>
      <Field label={m.kind === 'text' ? 'Text' : 'Note'}><Textarea value={v} onChange={(e) => setV(e.target.value)} maxLength={2000} rows={2} /></Field>
      <div><Button type="submit" disabled={v === (m.body ?? '') || (m.kind === 'text' && !v.trim())}>Save note</Button></div>
    </form>
  );
}

export type { DrawingRevisionRow };
