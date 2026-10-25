'use client';

import { useMemo, useState } from 'react';
import { Button, ButtonRow, ConfirmDialog, Field, QueueTable, Seg, Select, Status, count, money, type QueueColumn } from '@meritbooks/merit-ui';
import { CAD_SOURCES, CAD_SOURCE_LABELS, parseCadFile, type CadSource } from '@/lib/mfg/cad-import';
import type { CadImportRow } from '@/app/api/mfg/cad/route';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, JobSelect, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, FilePick, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';

interface DiffLine { kind: string; key: string; description: string | null; estimated_qty: number | null; cad_qty: number | null; delta_qty: number | null; delta_cost_cents: number | null; status: string }
interface ImportDetail { import: CadImportRow; lines: Array<{ id: string; line_no: number; line_kind: string; assembly_ref: string | null; description: string; material: string | null; qty: number; uom: string | null; length_mm: number | null; width_mm: number | null; thickness_mm: number | null }>; page: number }

const DIFF_WORD: Record<string, [string, 'ready' | 'track' | 'risk' | 'blocked']> = {
  MATCH: ['Matches the estimate', 'ready'], OVER: ['More than estimated', 'risk'], UNDER: ['Less than estimated', 'track'],
  NOT_ESTIMATED: ['Drawn, not estimated', 'blocked'], NOT_IN_CAD: ['Estimated, not drawn', 'track'],
};

/** CAD / CAM cut lists in, diffed against the sold estimate, applied as the work order's bill of materials. */
export function CadImportView({ jobs, today, initialJob }: { jobs: JobOption[]; today: string; initialJob: string | null }) {
  const { readOnly } = useShell();
  const [job, setJob] = useState(initialJob ?? '');
  const [source, setSource] = useState<CadSource>('CABINET_VISION');
  const [units, setUnits] = useState<'auto' | 'mm' | 'in'>('auto');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const list = useBoard<{ imports: CadImportRow[] }>(job ? `/api/mfg/cad?job=${job}` : null);
  const detail = useBoard<ImportDetail>(openId ? `/api/mfg/cad/${openId}` : null);
  const { run, busy, error } = useDo(() => { list.reload(); detail.reload(); });
  const preview = useMemo(() => (file ? parseCadFile(file.text, source, units) : null), [file, source, units]);
  const rawDiff = detail.data?.import.diff;
  const diff: DiffLine[] = Array.isArray(rawDiff) ? (rawDiff as DiffLine[]) : [];

  const cols: QueueColumn<CadImportRow>[] = [
    { id: 'f', header: 'File', cell: (i) => <><span className="l1">{i.file_name}</span><span className="l2">{CAD_SOURCE_LABELS[i.source as CadSource] ?? i.source} · {day(i.created_at, today)}</span></> },
    { id: 'c', header: 'Contents', width: 280, cell: (i) => <span className="l2">{count(i.counts.assemblies ?? 0)} cabinets · {count(i.counts.parts ?? 0)} parts · {qty(i.counts.sheets ?? 0)} sheets · {qty(i.counts.edgeband_lf ?? 0)} LF band</span> },
    { id: 's', header: 'Status', width: 120, cell: (i) => <Status kind={i.status === 'APPLIED' ? 'ready' : 'track'} pip={i.status === 'APPLIED' ? 'closed' : 'open'}>{i.status === 'APPLIED' ? 'In the BOM' : i.status.toLowerCase()}</Status> },
  ];
  const diffCols: QueueColumn<DiffLine>[] = [
    { id: 'k', header: 'Material', cell: (l) => <><span className="l1">{l.description ?? l.key}</span><span className="l2">{l.kind.toLowerCase()} · {l.key}</span></> },
    { id: 'e', header: 'Estimated', numeric: true, width: 100, cell: (l) => qty(l.estimated_qty) },
    { id: 'c', header: 'Drawn', numeric: true, width: 100, cell: (l) => qty(l.cad_qty) },
    { id: 'd', header: 'Difference', numeric: true, width: 110, cell: (l) => <span className={(l.delta_qty ?? 0) > 0 ? 'neg b' : undefined}>{l.delta_qty == null ? '—' : `${l.delta_qty > 0 ? '+' : ''}${qty(l.delta_qty)}`}</span> },
    { id: 'm', header: 'Cost effect', numeric: true, width: 120, cell: (l) => (l.delta_cost_cents == null ? '—' : money(l.delta_cost_cents)) },
    { id: 's', header: 'Check', width: 190, cell: (l) => { const w = DIFF_WORD[l.status] ?? [l.status, 'track']; return <Status kind={w[1]} pip="open">{w[0]}</Status>; } },
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs} value={job} onChange={(id) => { setJob(id); setOpenId(null); }} /></Field>
      </div>
      {!job ? <Empty title="Pick a job" body="Imports, their diff against the estimate, and the BOM they become are per job." /> : (
        <>
          {!readOnly && (
            <Section title="Import a cut list" meta="CSV part list or project XML">
              <div className="ops-toolbar">
                <Field label="From"><Select value={source} onChange={(e) => setSource(e.target.value as CadSource)}>{CAD_SOURCES.map((s) => <option key={s} value={s}>{CAD_SOURCE_LABELS[s]}</option>)}</Select></Field>
                <Field label="Units"><Seg<'auto' | 'mm' | 'in'> aria-label="Units" value={units} onChange={setUnits} items={[{ value: 'auto', label: 'Detect' }, { value: 'mm', label: 'mm' }, { value: 'in', label: 'inches' }]} /></Field>
                <FilePick label="Choose file" accept=".csv,.txt,.tsv,.xml" onText={(name, text) => setFile({ name, text })} />
              </div>
              {preview && (
                <div className="stack" style={{ marginTop: 8 }}>
                  <p className="t-cap">{file?.name}: {count(preview.summary.assemblies)} cabinets · {count(preview.summary.parts)} parts · {qty(preview.summary.sheets)} sheets · {qty(preview.summary.edgebandLf)} LF band · {qty(preview.summary.hardware)} hardware · read in {preview.units === 'in' ? 'inches' : 'mm'}</p>
                  {preview.issues.slice(0, 5).map((i) => <p key={`${i.row}${i.message}`} className="t-cap neg">Row {i.row}: {i.message}</p>)}
                  <ButtonRow>
                    <Button variant="primary" disabled={!preview.lines.length || busy === 'stage'} onClick={async () => {
                      const r = await run<{ import_id: string }>('stage', '/api/mfg/cad', { jobId: job, source, fileName: file!.name, text: file!.text, units }, 'Imported; compared with the estimate');
                      if (r) { setFile(null); setOpenId(r.import_id); }
                    }}>Import and compare</Button>
                    <Button variant="quiet" onClick={() => setFile(null)}>Clear</Button>
                  </ButtonRow>
                </div>
              )}
            </Section>
          )}
          {error && <Failure text={error} />}
          <Section title="Imports">
            <BoardState b={list} what="Imports" />
            {list.data && (list.data.imports.length === 0 ? <Empty title="No imports on this job" body="Export the job’s cut list from the design software and import it here; the material is checked against the estimate before it becomes the BOM." /> :
              <div className="mp-table"><QueueTable aria-label="CAD imports" columns={cols} rows={list.data.imports} getRowId={(i) => i.id} cursorId={openId} openOnClick onOpen={(i) => setOpenId(i.id)} rowState={(i) => ({ attn: i.status !== 'APPLIED' })} /></div>)}
          </Section>
          {openId && (
            <Section title="Drawn vs estimated" meta={detail.data ? detail.data.import.file_name : undefined}
              actions={detail.data && detail.data.import.status !== 'APPLIED' && !readOnly ? <Button variant="primary" disabled={busy === 'apply'} onClick={() => setConfirm(true)}>Apply as the BOM</Button> : undefined}>
              <BoardState b={detail} what="The comparison" />
              {detail.data && (diff.length === 0 ? <p className="t-cap">No estimate to compare with: the cut list applies as drawn.</p> :
                <div className="mp-table"><QueueTable aria-label="Material comparison" columns={diffCols} rows={diff} getRowId={(l) => `${l.kind}:${l.key}`} rowState={(l) => ({ attn: l.status === 'OVER' || l.status === 'NOT_ESTIMATED' })} /></div>)}
              {detail.data && detail.data.lines.length > 0 && (
                <table className="ops-mini" aria-label="Cut list" style={{ marginTop: 16 }}>
                  <thead><tr><th>#</th><th>Cabinet</th><th>Part</th><th>Material</th><th className="n">Qty</th><th className="n">L × W × T mm</th></tr></thead>
                  <tbody>{detail.data.lines.slice(0, 200).map((l) => <tr key={l.id}><td>{l.line_no}</td><td>{l.assembly_ref ?? ''}</td><td>{l.description}</td><td>{l.material ?? ''}</td><td className="n">{qty(l.qty, l.uom)}</td><td className="n">{[l.length_mm, l.width_mm, l.thickness_mm].map((x) => (x == null ? '—' : qty(x))).join(' × ')}</td></tr>)}</tbody>
                </table>
              )}
            </Section>
          )}
        </>
      )}
      <ConfirmDialog open={confirm} title="Apply this cut list as the bill of materials?" confirmLabel="Apply as the BOM" onClose={() => setConfirm(false)}
        onConfirm={async () => { setConfirm(false); if (openId) await run('apply', `/api/mfg/cad/${openId}`, { op: 'apply' }, 'The cut list is the work order’s BOM'); }}>
        Lines from an earlier import on the same work order are replaced. Purchasing reads the BOM for what to order.
      </ConfirmDialog>
    </div>
  );
}
