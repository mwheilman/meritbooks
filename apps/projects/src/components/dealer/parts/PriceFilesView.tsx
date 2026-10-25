'use client';

import { useMemo, useState } from 'react';
import { Bands, Button, ButtonRow, ConfirmDialog, Field, Input, QueueTable, Select, Status, count, money, type QueueColumn } from '@meritbooks/merit-ui';
import { PRICE_FILE_FORMATS, PRICE_FILE_FORMAT_LABELS, parsePriceFile, supersessionLoops, type PriceFileFormat } from '@/lib/dealer/price-files';
import type { PriceFileRowOut } from '@/app/api/dealer/price-files/route';
import type { PriceFileLineOut } from '@/app/api/dealer/price-files/[fileId]/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, FilePick, day, pctText, useBoard, useDo } from '../common/depth';

type Band = 'NEW' | 'CHANGED' | 'SUPERSEDED' | 'BELOW_FLOOR' | 'INVALID' | 'UNCHANGED';
const BANDS: Array<{ value: Band; label: string; caption: string }> = [
  { value: 'CHANGED', label: 'Price changes', caption: 'list or cost moved' },
  { value: 'NEW', label: 'New parts', caption: 'added to the catalog' },
  { value: 'SUPERSEDED', label: 'Supersessions', caption: 'old number → new' },
  { value: 'BELOW_FLOOR', label: 'Under margin floor', caption: 'matrix price too thin' },
  { value: 'INVALID', label: 'Problems', caption: 'skipped on apply' },
  { value: 'UNCHANGED', label: 'Unchanged', caption: 'no change' },
];

interface FileDetail {
  file: { id: string; manufacturer: string; file_name: string; status: string; summary: Record<string, number>; effective_on: string; row_count: number };
  lines: PriceFileLineOut[];
}

/** OEM price files: pick the file, preview what changes, stage it, review by band, apply (or discard). */
export function PriceFilesView({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const list = useBoard<{ files: PriceFileRowOut[] }>(`/api/dealer/price-files?company=${companyId}`);
  const [openId, setOpenId] = useState<string | null>(null);
  const [band, setBand] = useState<Band>('CHANGED');
  const detail = useBoard<FileDetail>(openId ? `/api/dealer/price-files/${openId}?action=${band}` : null);
  const reloadAll = () => { list.reload(); detail.reload(); };
  const { run, busy, error } = useDo(reloadAll);

  const [format, setFormat] = useState<PriceFileFormat>('GENERIC');
  const [mfr, setMfr] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<'apply' | 'discard' | null>(null);
  const preview = useMemo(() => (file ? parsePriceFile(file.text, format) : null), [file, format]);
  const loops = useMemo(() => (preview ? supersessionLoops(preview.rows) : []), [preview]);

  const stage = async () => {
    if (!file || !preview) return;
    const r = await run<{ file_id: string }>('stage', '/api/dealer/price-files', { companyId, manufacturer: mfr, format, fileName: file.name, effectiveOn: preview.effectiveOn, text: file.text }, (d) => `Staged ${file.name}`);
    if (r) { setFile(null); setOpenId(r.file_id); setBand('CHANGED'); }
  };

  const cols: QueueColumn<PriceFileRowOut>[] = [
    { id: 'f', header: 'File', cell: (f) => <><span className="l1">{f.file_name}</span><span className="l2">{f.manufacturer} · {PRICE_FILE_FORMAT_LABELS[f.format as PriceFileFormat] ?? f.format}</span></> },
    { id: 'e', header: 'Effective', width: 110, cell: (f) => day(f.effective_on, today) },
    { id: 'r', header: 'Rows', numeric: true, width: 90, cell: (f) => count(f.row_count) },
    { id: 's', header: 'What changes', width: 300, cell: (f) => <span className="l2">{count(f.summary.changed ?? 0)} changed · {count(f.summary.new ?? 0)} new · {count(f.summary.superseded ?? 0)} superseded{(f.summary.below_floor ?? 0) > 0 ? ` · ${count(f.summary.below_floor ?? 0)} under floor` : ''}</span> },
    { id: 'st', header: 'Status', width: 120, cell: (f) => <Status kind={f.status === 'APPLIED' ? 'ready' : f.status === 'STAGED' ? 'track' : 'blocked'} pip={f.status === 'APPLIED' ? 'closed' : f.status === 'STAGED' ? 'open' : 'soft'}>{f.status === 'APPLIED' ? 'Applied' : f.status === 'STAGED' ? 'Staged' : 'Discarded'}</Status> },
  ];

  const lineCols: QueueColumn<PriceFileLineOut>[] = [
    { id: 'p', header: 'Part', width: 160, cell: (l) => <><span className="l1 code">{l.part_number}</span><span className="l2">{l.supersedes_to ? `→ ${l.supersedes_to}` : l.category ?? ' '}</span></> },
    { id: 'd', header: 'Description', cell: (l) => <span className="l2">{l.error ?? l.description ?? ' '}</span> },
    { id: 'ol', header: 'Old list', numeric: true, width: 100, cell: (l) => (l.old_list_cents == null ? '—' : money(l.old_list_cents)) },
    { id: 'nl', header: 'New list', numeric: true, width: 100, cell: (l) => (l.list_price_cents == null ? '—' : money(l.list_price_cents)) },
    { id: 'c', header: 'Cost', numeric: true, width: 100, cell: (l) => (l.cost_cents == null ? '—' : money(l.cost_cents)) },
    { id: 'np', header: 'Counter price', numeric: true, width: 120, cell: (l) => (l.new_price_cents == null ? '—' : <b>{money(l.new_price_cents)}</b>) },
    { id: 'm', header: 'Margin', numeric: true, width: 90, cell: (l) => (l.margin_pct == null ? '—' : <span className={l.below_floor ? 'neg b' : undefined}>{pctText(l.margin_pct)}</span>) },
  ];

  return (
    <div className="stack">
      {!readOnly && (
        <Section title="Load a price file" meta="Nothing changes in the catalog until you apply it">
          <div className="ops-toolbar">
            <Field label="Manufacturer line code"><Input value={mfr} onChange={(e) => setMfr(e.target.value.toUpperCase())} placeholder="KUB" style={{ width: 120 }} /></Field>
            <Field label="Format"><Select value={format} onChange={(e) => setFormat(e.target.value as PriceFileFormat)}>{PRICE_FILE_FORMATS.map((f) => <option key={f} value={f}>{PRICE_FILE_FORMAT_LABELS[f]}</option>)}</Select></Field>
            <FilePick label="Choose file" accept=".csv,.txt,.tsv,.dat,.prn" onText={(name, text) => setFile({ name, text })} />
            <span className="sp" />
            {file && <span className="t-cap">{file.name}</span>}
          </div>
          {preview && (
            <div className="stack" style={{ marginTop: 12 }}>
              <p className="t-cap">{count(preview.rows.length)} rows read{preview.effectiveOn ? ` · effective ${day(preview.effectiveOn, today)}` : ''} · {count(preview.rows.filter((r) => r.supersedes_to).length)} supersessions{preview.issues.length ? ` · ${count(preview.issues.length)} problems` : ''}</p>
              {preview.issues.slice(0, 5).map((i) => <p key={`${i.row}${i.message}`} className="t-cap neg">Row {i.row}: {i.message}</p>)}
              {loops.length > 0 && <Failure title="Supersessions loop." text={loops.slice(0, 3).map((l) => l.join(' → ')).join('; ')} />}
              <ButtonRow>
                <Button variant="primary" disabled={!mfr || !preview.rows.length || loops.length > 0 || busy === 'stage'} onClick={() => void stage()}>Stage {count(preview.rows.length)} rows</Button>
                <Button variant="quiet" onClick={() => setFile(null)}>Clear</Button>
              </ButtonRow>
            </div>
          )}
        </Section>
      )}
      {error && <Failure text={error} />}
      <Section title="Price files" meta="Newest first">
        <BoardState b={list} what="Price files" />
        {list.data && (list.data.files.length === 0
          ? <Empty title="No price files yet" body="Load the manufacturer’s parts price file above. Merit Projects shows every price change, new part and supersession before anything changes." />
          : <div className="mp-table"><QueueTable aria-label="Price files" columns={cols} rows={list.data.files} getRowId={(f) => f.id} cursorId={openId} openOnClick onOpen={(f) => { setOpenId(f.id); setBand('CHANGED'); }} rowState={(f) => ({ attn: f.status === 'STAGED' })} /></div>)}
      </Section>
      {openId && (
        <Section title={detail.data ? detail.data.file.file_name : 'Price file'} meta={detail.data ? `${detail.data.file.manufacturer} · effective ${day(detail.data.file.effective_on, today)}` : undefined}
          actions={detail.data?.file.status === 'STAGED' && !readOnly ? (
            <ButtonRow>
              <Button variant="primary" disabled={busy === 'apply'} onClick={() => setConfirm('apply')}>Apply to catalog</Button>
              <Button variant="quiet" disabled={busy === 'discard'} onClick={() => setConfirm('discard')}>Discard</Button>
            </ButtonRow>
          ) : undefined}>
          {detail.data && (
            <Bands<Band> aria-label="Lines by change" value={band} onChange={setBand}
              items={BANDS.map((b) => ({ value: b.value, label: b.label, caption: b.caption, count: count(b.value === 'BELOW_FLOOR' ? detail.data!.file.summary.below_floor ?? 0 : detail.data!.file.summary[b.value.toLowerCase()] ?? 0) }))} />
          )}
          <BoardState b={detail} what="Lines" />
          {detail.data && (detail.data.lines.length === 0
            ? <Empty title="Nothing in this band" body="Pick another band above." />
            : <div className="mp-table"><QueueTable aria-label="Price file lines" columns={lineCols} rows={detail.data.lines} getRowId={(l) => l.id} rowState={(l) => ({ attn: l.below_floor || l.action === 'INVALID' })} /></div>)}
        </Section>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'apply' ? 'Apply this price file?' : 'Discard this price file?'}
        confirmLabel={confirm === 'apply' ? 'Apply to catalog' : 'Discard file'}
        tone={confirm === 'discard' ? 'danger' : 'primary'}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          const op = confirm;
          setConfirm(null);
          if (openId && op) await run(op, `/api/dealer/price-files/${openId}`, { op }, op === 'apply' ? 'Applied the price file' : 'Discarded the price file');
        }}
      >
        {confirm === 'apply' ? 'New parts are created, list, cost and counter prices update, and supersessions are chained. Lines with problems are skipped.' : 'The staged file is set aside. The catalog does not change.'}
      </ConfirmDialog>
    </div>
  );
}
