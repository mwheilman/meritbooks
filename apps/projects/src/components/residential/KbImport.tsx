'use client';

import { useState } from 'react';
import { Button, Field, InlineNotice, Input, QueueTable, Select, Status, money, type QueueColumn } from '@meritbooks/merit-ui';
import type { KbImportRow, KbLineRow } from '@/app/api/residential/proposals/[proposalId]/kb-import/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, FilePick, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { KB_SOURCE_LABELS, KB_SOURCES, type KbSource } from '@/lib/residential/kb-import';

interface CatalogItem { id: string; code: string; name: string }

/** K&B design-software import (RES-23): drop the 2020 / Cabinet Vision / ProKitchen list, map unknown SKUs once, land priced lines on the proposal. */
export function KbImport({ proposalId, catalog, draft }: { proposalId: string; catalog: CatalogItem[]; draft: boolean }) {
  const { readOnly } = useShell();
  const url = `/api/residential/proposals/${proposalId}/kb-import`;
  const b = useBoard<{ imports: KbImportRow[]; lines: KbLineRow[] }>(url);
  const { run, busy, error } = useDo(b.reload);
  const [source, setSource] = useState<KbSource | ''>('');
  const [room, setRoom] = useState('');
  const [markup, setMarkup] = useState<number | null>(null);
  const [issues, setIssues] = useState<Array<{ row: number; message: string }>>([]);
  const staged = b.data?.imports.find((i) => i.status === 'STAGED') ?? null;
  const lines = (b.data?.lines ?? []).filter((l) => l.import_id === staged?.id);
  const cols: QueueColumn<KbLineRow>[] = [
    { id: 's', header: 'SKU', width: 130, cell: (l) => <b>{l.sku}</b> },
    { id: 'd', header: 'Description', cell: (l) => <><span className="l1">{l.description || '—'}</span><span className="l2">{[l.finish, l.room].filter(Boolean).join(' · ')}</span></> },
    { id: 'q', header: 'Qty', numeric: true, width: 70, cell: (l) => qty(l.qty) },
    { id: 'p', header: 'List', numeric: true, width: 100, cell: (l) => (l.list_price_cents == null ? '—' : money(l.list_price_cents)) },
    { id: 'm', header: 'Catalog item', width: 320, cell: (l) => (l.match_kind === 'SKIPPED' ? <Status kind="blocked" pip="closed">Skipped</Status> :
      readOnly || !draft ? (catalog.find((c) => c.id === l.catalog_item_id)?.code ?? <Status kind="risk" pip="risk">Unmapped</Status>) :
        <Select aria-label={`Catalog item for ${l.sku}`} value={l.catalog_item_id ?? ''} onChange={(e) => run(`m${l.id}`, url, { op: 'map', lineId: l.id, catalogItemId: e.target.value || null, remember: true }, null)}>
          <option value="">{l.match_kind === 'NONE' ? 'Unmapped — pick or skip' : 'Skip this line'}</option>{catalog.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select>) },
  ];
  if (!draft) return <InlineNotice tone="info" title="This proposal is sent.">Revise it to import a cabinet list into a new version.</InlineNotice>;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!readOnly && !staged && (
        <Section title="Import a cabinet list" meta="2020 Design, Cabinet Vision or ProKitchen — CSV or XML">
          <div className="ops-toolbar">
            <Field label="Program"><Select value={source} onChange={(e) => setSource(e.target.value as KbSource | '')}><option value="">Detect from the file</option>{KB_SOURCES.map((s) => <option key={s} value={s}>{KB_SOURCE_LABELS[s]}</option>)}</Select></Field>
            <Field label="Room (if the file has none)"><Input value={room} onChange={(e) => setRoom(e.target.value)} /></Field>
            <FilePick label="Choose the file" accept=".csv,.txt,.xml,.tsv" disabled={busy === 'stage'} onText={async (name, text) => {
              const r = await run<{ issues: Array<{ row: number; message: string }>; lines: number; matched: number }>('stage', url, { op: 'stage', fileName: name, text, source: source || null, room: room || null }, (x: { lines: number; matched: number }) => `${x.lines} lines, ${x.matched} matched`);
              setIssues(r?.issues ?? []);
            }} />
          </div>
        </Section>
      )}
      {issues.length > 0 && <InlineNotice tone="warn" title={`${issues.length} row(s) could not be read.`}>{issues.slice(0, 5).map((i) => `Row ${i.row}: ${i.message}`).join(' · ')}</InlineNotice>}
      <BoardState b={b} what="Imports" />
      {staged && (
        <Section title={`${staged.file_name ?? 'Import'} · ${staged.matched_count} of ${staged.line_count} mapped`} actions={readOnly ? null : <span className="btn-row">
          <Field label="Markup for unmapped lines"><PctInput value={markup} onChange={setMarkup} aria-label="Markup" /></Field>
          <Button variant="primary" disabled={busy === 'apply'} onClick={() => run('apply', url, { op: 'apply', importId: staged.id, markupPct: markup }, (r: { lines_added: number }) => `Added ${r.lines_added} lines to the proposal`)}>Add to the proposal</Button>
          <Button variant="quiet" onClick={() => run('disc', url, { op: 'discard', importId: staged.id }, 'Discarded')}>Discard</Button></span>}>
          <div className="mp-table"><QueueTable aria-label="Imported lines" columns={cols} rows={lines} getRowId={(l) => l.id} rowState={(l) => ({ attn: l.match_kind === 'NONE' })} /></div>
        </Section>
      )}
      {b.data && !staged && b.data.imports.length === 0 && <Empty title="No imports yet" body="Export the item list from the design program and drop it here; known SKUs map to the catalog, new ones are learned the first time." />}
      {b.data && b.data.imports.filter((i) => i.status !== 'STAGED').map((i) => <p key={i.id} className="l2">{i.file_name} · {i.status.toLowerCase()} · {i.applied_lines} line(s)</p>)}
    </div>
  );
}
