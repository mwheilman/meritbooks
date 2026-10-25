'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Field, InlineNotice, Input, Meter, Select, countStrokes, toast } from '@meritbooks/merit-ui';
import { disciplineOf, guessSheets, placeholderNumber, type SheetGuess } from '@/lib/documents/sheets';
import { SET_KINDS, SET_KIND_LABEL, type SetKind } from '@/lib/documents/types';
import { extractPages } from '../pdf/pdfjs';
import { postForm } from '../client';

interface Row extends SheetGuess { edited: boolean }

/**
 * Upload a PDF set: the browser reads each page's text layer (pdf.js) and proposes the sheet
 * number, title and revision from the title block; the uploader corrects them; the server splits
 * the set into one PDF per sheet. Scans without text get placeholders to rename here or later.
 */
export function SetUpload({ open, onClose, jobId }: { open: boolean; onClose: () => void; jobId: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [setKind, setSetKind] = useState<SetKind>('ifc');
  const [issuedOn, setIssuedOn] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<Row[]>([]);
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (f: File) => {
    setFile(f);
    setError(null);
    setNotice(null);
    setName(f.name.replace(/\.pdf$/i, '').slice(0, 120));
    setRows([]);
    setReading({ done: 0, total: 0 });
    try {
      const pages = await extractPages(await f.arrayBuffer(), (done, total) => setReading({ done, total }));
      const guesses = guessSheets(pages);
      setRows(guesses.map((g) => ({ ...g, edited: false })));
      const none = guesses.filter((g) => g.source === 'none').length;
      if (none) setNotice(`${none} of ${guesses.length} pages had no readable title block (scans?). Type their sheet numbers below, or fix them after upload.`);
    } catch {
      setNotice('This browser could not read the PDF text. Sheet numbers will be placeholders you can rename after upload.');
      setRows([]);
    } finally {
      setReading(null);
    }
  };

  const set = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch, edited: true } : x)));
  const dupes = new Set(rows.map((r) => r.sheetNumber.trim().toUpperCase()).filter((n, i, a) => n && a.indexOf(n) !== i));

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('file', file);
    form.set('jobId', jobId);
    form.set('name', name.trim() || file.name);
    form.set('setKind', setKind);
    if (issuedOn) form.set('issuedOn', issuedOn);
    form.set('pages', JSON.stringify(rows.map((r) => ({
      index: r.index, sheetNumber: r.sheetNumber.trim() || placeholderNumber(r.index), title: r.title?.trim() || null,
      discipline: r.discipline || disciplineOf(r.sheetNumber), revision: r.revision?.trim() || null,
      extraction: r.edited ? 'manual' : r.source, confidence: r.edited ? null : r.confidence,
    }))));
    const r = await postForm<{ setId: string; added: unknown[]; failed: Array<{ sheetNumber: string; error: string }> }>('/api/documents/drawings', form);
    setBusy(false);
    if (r.error || !r.data) { setError(r.error); return; }
    toast(`Uploaded ${r.data.added.length} sheets for review`);
    onClose();
    router.push(`/documents/drawings/sets/${r.data.setId}`);
  };

  return (
    <Dialog open={open} onClose={onClose} title="Upload a drawing set" width={880} dismissOnScrim={false}
      actions={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!file || busy || !!reading || dupes.size > 0} onClick={() => void submit()}>{busy ? 'Splitting the set…' : `Upload ${rows.length || ''} sheets`.replace('  ', ' ')}</Button></>}
      footNote="The set goes in for review first; publishing it makes its sheets the current set.">
      <div className="stack">
        <div className="mp-form-2">
          <Field label="PDF set"><Input type="file" accept="application/pdf,.pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); }} /></Field>
          <Field label="Set name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
          <Field label="Kind">
            <Select value={setKind} onChange={(e) => setSetKind(e.target.value as SetKind)}>
              {SET_KINDS.map((k) => <option key={k} value={k}>{SET_KIND_LABEL[k]}</option>)}
            </Select>
          </Field>
          <Field label="Issued"><Input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} /></Field>
        </div>
        {reading && <div><p className="t-cap">Reading title blocks… {reading.total ? `${reading.done} of ${reading.total}` : ''}</p><Meter strokes={countStrokes(8, reading.total ? Math.round((reading.done / reading.total) * 8) : 0)} label={`Read ${reading.done} of ${reading.total} pages`} /></div>}
        {notice && <InlineNotice tone="warn" title="Check the sheet numbers">{notice}</InlineNotice>}
        {dupes.size > 0 && <InlineNotice tone="neg" title="Two pages have the same number">{[...dupes].join(', ')} — give each page its own sheet number.</InlineNotice>}
        {rows.length > 0 && (
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            <table className="ops-mini dwg-review">
              <thead><tr><th>Page</th><th>Sheet</th><th>Title</th><th>Rev</th><th>Read from</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.index}>
                    <td className="n">{r.index + 1}</td>
                    <td><Input aria-label={`Sheet number, page ${r.index + 1}`} value={r.sheetNumber} onChange={(e) => set(i, { sheetNumber: e.target.value.toUpperCase(), discipline: disciplineOf(e.target.value) })} maxLength={40} /></td>
                    <td><Input aria-label={`Sheet title, page ${r.index + 1}`} value={r.title ?? ''} onChange={(e) => set(i, { title: e.target.value })} maxLength={200} /></td>
                    <td><Input aria-label={`Revision, page ${r.index + 1}`} value={r.revision ?? ''} onChange={(e) => set(i, { revision: e.target.value })} maxLength={20} style={{ width: 60 }} /></td>
                    <td className="t-cap">{r.edited ? 'You' : r.source === 'text' ? `Title block (${Math.round(r.confidence * 100)}%)` : 'Not found'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && <InlineNotice tone="neg" title="Not uploaded.">{error}</InlineNotice>}
      </div>
    </Dialog>
  );
}
