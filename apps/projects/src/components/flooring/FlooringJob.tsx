'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Check, Field, InlineNotice, Input, Select, Status, count, money } from '@meritbooks/merit-ui';
import { MEASURE_SOURCES, MEASURE_SOURCE_LABELS, parseMeasureFile, type MeasureSource } from '@/lib/flooring/measure-import';
import { materialQty, type FlooringUom } from '@/lib/flooring/uom';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, FilePick, day, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';

interface Area { id: string; measure_id: string; room_name: string; area_kind: string; product_category: string | null; sqft: number; linear_ft: number | null; each_count: number | null; waste_pct: number }
interface Gate { key: 'material' | 'deposit' | 'site'; ok: boolean; open_items?: Array<{ description: string; status: string }>; required_pct?: number; detail?: { none_requested?: boolean; books_available?: boolean; all_paid?: boolean }; checks?: Array<{ check: string; passed: boolean | null; reading: number | null; recorded_at: string | null }> }
interface JobData {
  settings: { tax_mode: string; exemption_ref: string | null; price_level: string; deposit_pct: number | null; required_site_checks: string[] | null } | null;
  measures: Array<{ id: string; source: string; measured_on: string }>; areas: Area[];
  quoteLines: Array<{ id: string; estimate_id: string; room: string; line_class: string; tier: string | null; measured_qty: number; uom: string; waste_pct: number | null }>;
  readiness: { ready: boolean; checks: Gate[] };
  lots: { warnings: Array<{ code: string; style: string; lots: string[]; one_lot_can_cover: boolean }> };
  tickets: Array<{ id: string; number: string; status: string; due_on: string | null; warnings: Array<{ code: string; style?: string }> }>;
  cuts: Array<{ id: string; ticket_id: string; roll_id: string; seq: number; room: string | null; planned_len_in: number; actual_len_in: number | null; status: string }>;
  bookings: Array<{ id: string; install_on: string; days: number; sf: number; status: string; readiness_override_reason: string | null; capacity_override_reason: string | null }>;
}
interface Product { id: string; sku: string | null; style: string; color: string | null; category: string; sell_uom: FlooringUom; roll_width_ft: number | null; carton_sf: number | null; waste_pct: number | null; price_retail_cents: number | null; is_active: boolean }

const CHECK_WORD: Record<string, string> = { MOISTURE: 'Moisture test', OLD_FLOOR_REMOVED: 'Old floor removed', FURNITURE_MOVED: 'Furniture moved', HVAC_RUNNING: 'HVAC running', SUBFLOOR_FLAT: 'Subfloor flat', OTHER: 'Other' };
const FLAG_WORD: Record<string, string> = { CARPET_NO_PAD: 'Carpet without pad', HARD_SURFACE_NO_TRANSITION: 'Hard surface with no transitions measured', STAIRS_NO_LABOR: 'Stairs without a stair labor rate', NO_INSTALL_LABOR: 'No install labor rate for this category', STAIRS_NO_STEP_COUNT: 'Stairs with no step count' };

/** One flooring job: measure in, quote out (UoM, waste, tax mode), readiness, lots and cuts, and the install booking. */
export function FlooringJob({ jobId, companyId, today }: { jobId: string; companyId: string; today: string }) {
  const { readOnly } = useShell();
  const b = useBoard<JobData>(`/api/flooring/jobs/${jobId}`);
  const cat = useBoard<{ products: Product[] }>(`/api/flooring/catalog?company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const url = `/api/flooring/jobs/${jobId}`;
  const [src, setSrc] = useState<MeasureSource>('MEASURESQUARE');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const preview = useMemo(() => (file ? parseMeasureFile(file.text, src) : null), [file, src]);
  const [choice, setChoice] = useState<Record<string, { product: string; pad: string; prep: boolean; demo: boolean; moving: boolean }>>({});
  const [tax, setTax] = useState<{ mode: string; ref: string; level: string; dep: number | null } | null>(null);
  const [site, setSite] = useState({ check: 'MOISTURE', passed: true, reading: '' });
  const [cut, setCut] = useState({ product: '', length: '', room: '', roll: '' });
  const [suggest, setSuggest] = useState<Array<{ roll_id: string; roll_number: string; dye_lot: string; status: string; available_in: number; leftover_in: number; same_lot: boolean }> | null>(null);
  const [book, setBook] = useState({ on: today, days: '1', reason: '' });
  const [actual, setActual] = useState<Record<string, string>>({});

  const state = <BoardState b={b} what="The job" />;
  if (!b.data) return state;
  const d = b.data;
  const products = (cat.data?.products ?? []).filter((p) => p.is_active);
  const pads = products.filter((p) => p.category === 'PAD');
  const t = tax ?? { mode: d.settings?.tax_mode ?? 'RETAIL', ref: d.settings?.exemption_ref ?? '', level: d.settings?.price_level ?? 'RETAIL', dep: d.settings?.deposit_pct ?? null };
  const measure = d.measures[0] ?? null;
  const floorAreas = d.areas.filter((a) => ['FLOOR', 'STAIRS', 'WALL', 'OTHER'].includes(a.area_kind));
  const totalSf = floorAreas.reduce((s, a) => s + Number(a.sqft), 0);
  const gate = (k: Gate['key']) => d.readiness.checks.find((c) => c.key === k);

  const lineQty = (a: Area, p: Product | undefined) => {
    if (!p) return null;
    const uom: FlooringUom = a.area_kind === 'STAIRS' && p.sell_uom !== 'SY' ? 'STEP' : p.sell_uom;
    try { return materialQty({ uom, sf: Number(a.sqft), lf: Number(a.linear_ft ?? 0), each: Number(a.each_count ?? 0), waste: Number(p.waste_pct ?? a.waste_pct ?? 0.1), cartonSf: p.carton_sf ?? undefined, rollWidthFt: p.roll_width_ft ?? undefined }); } catch { return null; }
  };

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <div className="dl-strip">
        <p><span className="t-cap">Measured</span><br /><b className="tnum">{qty(totalSf)} SF</b> · {count(d.areas.length)} areas</p>
        <p><span className="t-cap">Tax</span><br />{t.mode === 'REAL_PROPERTY' ? 'Real property (contractor pays on material)' : t.mode === 'EXEMPT' ? 'Exempt' : 'Retail sale (tax on the invoice)'}</p>
        <p><span className="t-cap">Ready to install</span><br />{d.readiness.ready ? <Status kind="ready" pip="ready">Ready</Status> : <Status kind="blocked" pip="blocked">Not yet</Status>}</p>
      </div>
      <Section title="Measure" meta={measure ? `${MEASURE_SOURCE_LABELS[(measure.source === 'IMPORT' ? 'GENERIC' : measure.source) as MeasureSource] ?? measure.source} · ${day(measure.measured_on, today)}` : 'None yet'}>
        {!readOnly && (
          <div className="ops-toolbar">
            <Field label="From"><Select value={src} onChange={(e) => setSrc(e.target.value as MeasureSource)}>{MEASURE_SOURCES.map((s) => <option key={s} value={s}>{MEASURE_SOURCE_LABELS[s]}</option>)}</Select></Field>
            <FilePick label="Choose measure file" accept=".csv,.txt,.xml,.tsv" onText={(name, text) => setFile({ name, text })} />
            {preview && <span className="t-cap">{count(preview.rooms.length)} rooms · {qty(preview.totals.sqft)} SF · {qty(preview.totals.linearFt)} LF · {count(preview.totals.steps)} steps</span>}
            {preview && <Button variant="primary" disabled={!preview.rooms.length || busy === 'imp'} onClick={async () => { if (await run('imp', url, { op: 'import_measure', source: src, fileName: file!.name, text: file!.text }, 'Imported the measure')) setFile(null); }}>Import</Button>}
          </div>
        )}
        {preview?.issues.slice(0, 4).map((i) => <p key={`${i.row}${i.message}`} className="t-cap neg">{i.message}</p>)}
        {d.areas.length === 0 ? <Empty title="No measure yet" body="Import the MeasureSquare or RFMS file (or a room list) and every room arrives with its square feet, base and steps." /> : (
          <table className="ops-mini" aria-label="Areas and product choices">
            <thead><tr><th>Room</th><th>Kind</th><th className="n">SF</th><th className="n">LF / steps</th><th>Product</th><th>Pad</th><th className="n">Order</th><th>Prep</th><th>Demo</th><th>Move</th></tr></thead>
            <tbody>{d.areas.map((a) => {
              const c = choice[a.id] ?? { product: '', pad: '', prep: false, demo: false, moving: false };
              const p = products.find((x) => x.id === c.product);
              const q = lineQty(a, p);
              const set = (patch: Partial<typeof c>) => setChoice({ ...choice, [a.id]: { ...c, ...patch } });
              return (
                <tr key={a.id}>
                  <td>{a.room_name}</td><td>{a.area_kind.toLowerCase()}</td><td className="n">{qty(a.sqft)}</td><td className="n">{a.area_kind === 'STAIRS' ? `${a.each_count ?? 0} steps` : qty(a.linear_ft)}</td>
                  <td><Select aria-label={`Product for ${a.room_name}`} value={c.product} disabled={readOnly} onChange={(e) => set({ product: e.target.value })}><option value="">—</option>{products.filter((x) => x.category !== 'PAD' && (!a.product_category || x.category === a.product_category || a.area_kind === 'TRANSITION' || a.area_kind === 'BASE')).map((x) => <option key={x.id} value={x.id}>{x.style}{x.color ? ` ${x.color}` : ''}</option>)}</Select></td>
                  <td>{p?.category === 'CARPET' ? <Select aria-label={`Pad for ${a.room_name}`} value={c.pad} disabled={readOnly} onChange={(e) => set({ pad: e.target.value })}><option value="">No pad</option>{pads.map((x) => <option key={x.id} value={x.id}>{x.style}</option>)}</Select> : ''}</td>
                  <td className="n">{q ? `${qty(q.qty)} ${q.uom}${q.rollLf != null ? ` · ${qty(q.rollLf)} LF of roll` : ''}` : '—'}</td>
                  <td><Check label="Prep" checked={c.prep} disabled={readOnly} onChange={(e) => set({ prep: e.target.checked })} /></td>
                  <td><Check label="Demo" checked={c.demo} disabled={readOnly} onChange={(e) => set({ demo: e.target.checked })} /></td>
                  <td><Check label="Move furniture" checked={c.moving} disabled={readOnly} onChange={(e) => set({ moving: e.target.checked })} /></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </Section>
      {!readOnly && measure && (
        <Section title="Quote" meta="Material with waste in the sell unit, pad, install labor, prep, demo and moving by room">
          <div className="ops-toolbar">
            <Field label="Tax"><Select value={t.mode} onChange={(e) => setTax({ ...t, mode: e.target.value })}><option value="RETAIL">Retail sale</option><option value="REAL_PROPERTY">Real property improvement</option><option value="EXEMPT">Exempt</option></Select></Field>
            {t.mode === 'EXEMPT' && <Field label="Exemption certificate"><Input value={t.ref} onChange={(e) => setTax({ ...t, ref: e.target.value })} style={{ width: 160 }} /></Field>}
            <Field label="Price level"><Select value={t.level} onChange={(e) => setTax({ ...t, level: e.target.value })}><option value="RETAIL">Retail</option><option value="BUILDER">Builder</option><option value="CONTRACT">Contract</option></Select></Field>
            <Field label="Deposit"><PctInput aria-label="Deposit percent" value={t.dep} onChange={(v) => setTax({ ...t, dep: v })} /></Field>
            <Button disabled={busy === 'tax' || (t.mode === 'EXEMPT' && !t.ref.trim())} onClick={() => void run('tax', url, { op: 'settings', taxMode: t.mode, priceLevel: t.level, exemptionRef: t.ref || null, depositPct: t.dep }, 'Saved the tax and price settings')}>Save settings</Button>
            <span className="sp" />
            <Button variant="primary" disabled={busy === 'quote' || !Object.values(choice).some((c) => c.product)} onClick={async () => {
              const choices = Object.entries(choice).filter(([, c]) => c.product).map(([area_id, c]) => ({ area_id, product_id: c.product, pad_product_id: c.pad || null, prep: c.prep, demo: c.demo, moving: c.moving }));
              await run<{ estimate_id: string; flags: Array<{ code: string; room: string }>; total_cents: number | null }>('quote', url, { op: 'build_quote', measureId: measure.id, choices }, (r) => `Built the quote${r.total_cents != null ? ` · ${money(r.total_cents)}` : ''}${r.flags.length ? ` · ${r.flags.length} to check` : ''}`);
            }}>Build quote</Button>
          </div>
          {d.quoteLines.length > 0 && <p className="t-cap" style={{ marginTop: 8 }}>{count(d.quoteLines.length)} quote lines on the estimate. <Link className="link" href={`/jobs/${jobId}?tab=estimate`}>Open the estimate</Link></p>}
        </Section>
      )}
      <Section title="Ready to install?" meta="Deposit, material and site checks">
        <ul className="ops-checks">
          <li><span className={gate('deposit')?.ok ? 'ok' : 'no'}>{gate('deposit')?.ok ? 'Done' : 'Open'}</span> Deposit {pctText(gate('deposit')?.required_pct ?? 0, 0)}{gate('deposit')?.detail?.books_available === false ? ' · Merit Books does not report payments yet' : gate('deposit')?.detail?.none_requested ? ' · not requested' : ''}</li>
          <li><span className={gate('material')?.ok ? 'ok' : 'no'}>{gate('material')?.ok ? 'Done' : 'Open'}</span> Material received in good condition{(gate('material')?.open_items ?? []).length ? `: ${(gate('material')?.open_items ?? []).map((i) => `${i.description} (${i.status.toLowerCase()})`).join(', ')}` : ''}</li>
          {(gate('site')?.checks ?? []).map((c) => <li key={c.check}><span className={c.passed ? 'ok' : 'no'}>{c.passed ? 'Done' : c.passed === false ? 'Failed' : 'Open'}</span> {CHECK_WORD[c.check] ?? c.check}{c.reading != null ? ` · ${c.reading}` : ''}</li>)}
        </ul>
        {d.lots.warnings.length > 0 && <InlineNotice tone="warn" title="Mixed dye lots.">{d.lots.warnings.map((w) => `${w.style}: lots ${w.lots.join(', ')}${w.one_lot_can_cover ? ' (one lot on hand could cover the job)' : ''}`).join(' · ')}</InlineNotice>}
        {!readOnly && (
          <div className="ops-toolbar" style={{ marginTop: 8 }}>
            <Field label="Site check"><Select value={site.check} onChange={(e) => setSite({ ...site, check: e.target.value })}>{Object.entries(CHECK_WORD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
            <Field label="Reading"><Input inputMode="decimal" value={site.reading} onChange={(e) => setSite({ ...site, reading: e.target.value })} style={{ width: 90 }} /></Field>
            <Check label="Passed" checked={site.passed} onChange={(e) => setSite({ ...site, passed: e.target.checked })} />
            <Button disabled={busy === 'site'} onClick={() => void run('site', url, { op: 'site_check', check: site.check, passed: site.passed, reading: site.reading.trim() ? Number(site.reading) : null }, 'Recorded the site check')}>Record</Button>
          </div>
        )}
      </Section>
      <Section title="Cuts" meta={`${count(d.tickets.length)} cut tickets`}>
        {d.cuts.length > 0 && (
          <table className="ops-mini" aria-label="Cuts">
            <thead><tr><th>Ticket</th><th>Room</th><th className="n">Planned</th><th className="n">Cut</th><th /></tr></thead>
            <tbody>{d.cuts.map((c) => (
              <tr key={c.id}><td>{d.tickets.find((x) => x.id === c.ticket_id)?.number ?? ''} · {c.seq}</td><td>{c.room ?? ''}</td><td className="n">{qty(c.planned_len_in)}″</td>
                <td className="n">{c.status === 'CUT' ? `${qty(c.actual_len_in)}″` : readOnly ? '—' : <Input aria-label="Actual length in inches" inputMode="decimal" value={actual[c.id] ?? ''} placeholder={String(c.planned_len_in)} onChange={(e) => setActual({ ...actual, [c.id]: e.target.value })} style={{ width: 80 }} />}</td>
                <td>{c.status !== 'CUT' && !readOnly && <Button disabled={busy === c.id} onClick={() => void run(c.id, '/api/flooring/rolls', { op: 'record_cut', cutId: c.id, actualLenIn: actual[c.id] ? Number(actual[c.id]) : null }, (r: { roll_status: string; remaining_in: number }) => `Cut; roll is ${r.roll_status.toLowerCase()} with ${qty(r.remaining_in)}″ left`)}>Record cut</Button>}</td></tr>
            ))}</tbody>
          </table>
        )}
        {!readOnly && (
          <div className="ops-toolbar" style={{ marginTop: 8 }}>
            <Field label="Product"><Select value={cut.product} onChange={(e) => { setCut({ ...cut, product: e.target.value, roll: '' }); setSuggest(null); }}><option value="">Pick a rolled product</option>{products.filter((p) => p.roll_width_ft).map((p) => <option key={p.id} value={p.id}>{p.style}{p.color ? ` ${p.color}` : ''}</option>)}</Select></Field>
            <Field label="Length (in)"><Input inputMode="decimal" value={cut.length} onChange={(e) => setCut({ ...cut, length: e.target.value })} style={{ width: 90 }} /></Field>
            <Field label="Room"><Input value={cut.room} onChange={(e) => setCut({ ...cut, room: e.target.value })} style={{ width: 140 }} /></Field>
            <Button disabled={!cut.product || !(Number(cut.length) > 0) || busy === 'sug'} onClick={async () => { const r = await run<{ rolls: NonNullable<typeof suggest> }>('sug', '/api/flooring/rolls', { op: 'suggest', companyId, productId: cut.product, lengthIn: Number(cut.length), jobId }, null); if (r) setSuggest(r.rolls); }}>Find rolls</Button>
            {suggest && <Field label="Roll"><Select value={cut.roll} onChange={(e) => setCut({ ...cut, roll: e.target.value })}><option value="">{suggest.length ? 'Pick a roll' : 'No roll is long enough'}</option>{suggest.map((r) => <option key={r.roll_id} value={r.roll_id}>{r.roll_number} · lot {r.dye_lot}{r.same_lot ? ' (job’s lot)' : ''} · {qty(r.available_in)}″ free · {r.status.toLowerCase()}</option>)}</Select></Field>}
            <Button variant="primary" disabled={!cut.roll || busy === 'cut'} onClick={async () => { if (await run('cut', url, { op: 'cut_ticket', cuts: [{ roll_id: cut.roll, room: cut.room || null, length_in: Number(cut.length) }] }, (r: { number: string; warnings: unknown[] }) => `Cut ticket ${r.number}${r.warnings.length ? ' · lot warning' : ''}`)) { setCut({ product: cut.product, length: '', room: '', roll: '' }); setSuggest(null); } }}>Add cut ticket</Button>
          </div>
        )}
        {d.cuts.length === 0 && readOnly && <p className="t-cap">No cuts yet.</p>}
      </Section>
      <Section title="Install" meta={d.bookings.length ? `${count(d.bookings.length)} booked` : 'Not booked'}>
        {d.bookings.map((x) => <p key={x.id}>{day(x.install_on, today)} · {x.days} day{x.days === 1 ? '' : 's'} · {qty(x.sf)} SF · {x.status.toLowerCase()}{x.readiness_override_reason ? ` · booked before ready: ${x.readiness_override_reason}` : ''}</p>)}
        {!readOnly && (
          <div className="ops-toolbar">
            <Field label="Install on"><Input type="date" value={book.on} onChange={(e) => setBook({ ...book, on: e.target.value })} /></Field>
            <Field label="Days"><Input inputMode="numeric" value={book.days} onChange={(e) => setBook({ ...book, days: e.target.value })} style={{ width: 60 }} /></Field>
            {!d.readiness.ready && <Field label="Why book before it is ready"><Input value={book.reason} onChange={(e) => setBook({ ...book, reason: e.target.value })} style={{ width: 260 }} /></Field>}
            <Button variant="primary" disabled={busy === 'book' || (!d.readiness.ready && book.reason.trim().length < 5)} onClick={() => void run('book', url, { op: 'book_install', installOn: book.on, sf: Math.round(totalSf * 100) / 100, days: Number(book.days) > 0 ? Number(book.days) : 1, overrideReason: book.reason.trim() || null }, 'Booked the install')}>Book {qty(totalSf)} SF</Button>
          </div>
        )}
      </Section>
    </div>
  );
}
