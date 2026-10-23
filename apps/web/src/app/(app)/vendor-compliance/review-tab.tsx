'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AiPaused,
  Button,
  Check,
  ConfirmDialog,
  Field,
  InlineNotice,
  Input,
  KV,
  Pip,
  QueueTable,
  Seg,
  Select,
  Tag,
  api,
  toast,
  useQuery,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { COVERAGE_OPTIONS, centsToInput, dollarsToCentsInput, outcomeLook, relative, type ActionResponse, type QueueRow } from './vc-types';
import s from './vendor-compliance.module.css';

type View = 'open' | 'decided';

interface LineDraft {
  coverage_type: string;
  each: string;
  agg: string;
  effective: string;
  expiration: string;
}

const AI_WORD: Record<string, string> = { done: 'Read by AI', unavailable: 'AI paused', failed: 'AI could not read it', skipped: 'Typed by vendor', pending: 'Reading…' };

function linesFrom(r: QueueRow): LineDraft[] {
  const cov = r.extracted?.coi?.coverages ?? [];
  return cov.map((c) => ({
    coverage_type: c.coverage_type,
    each: centsToInput(c.each_occurrence_cents),
    agg: centsToInput(c.aggregate_cents),
    effective: c.effective_date ?? '',
    expiration: c.expiration_date ?? '',
  }));
}

export function ReviewTab({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [view, setView] = useState<View>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, error, isLoading, refetch } = useQuery<{ rows: QueueRow[] }>('/api/vendor-compliance/review', { status: view === 'decided' ? 'decided' : undefined }, { key: `${view}:${refreshKey}`, scope: false });
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && rows.length > 0 && view === 'open') setSelectedId(rows[0].id);
  }, [rows, selectedId, view]);

  const columns = useMemo<QueueColumn<QueueRow>[]>(
    () => [
      {
        id: 'check',
        header: 'Check',
        width: 136,
        cell: (r) => {
          const fails = (r.rule_results ?? []).filter((x) => !['met', 'expiring', 'grace'].includes(x.outcome)).length;
          if (r.status === 'accepted') return <span className="mb-sev"><Pip kind="ready" />Accepted</span>;
          if (r.status === 'rejected') return <span className="mb-sev"><Pip kind="closed" />Rejected</span>;
          if (r.rules_passed === null || (r.rule_results ?? []).length === 0) return <span className="mb-sev"><Pip kind="open" />Needs keying</span>;
          return fails ? <span className="mb-sev"><Pip kind="blocked" />{fails} failing</span> : <span className="mb-sev"><Pip kind="ready" />All pass</span>;
        },
      },
      {
        id: 'vendor',
        header: 'Vendor',
        cell: (r) => (
          <>
            <span className="l1">{r.vendor_name}</span>
            <span className="l2">{[r.doc_kind === 'W9' ? 'W-9' : 'Certificate of insurance', r.source === 'portal_w9_form' ? 'filled in the portal' : r.source === 'portal_upload' ? 'portal upload' : 'staff upload', AI_WORD[r.ai_status] ?? r.ai_status].join(' · ')}</span>
          </>
        ),
      },
      { id: 'when', header: view === 'open' ? 'Received' : 'Decided', width: 112, cell: (r) => <span className="ink-2">{relative(view === 'open' ? r.created_at : r.reviewed_at)}</span> },
    ],
    [view],
  );

  return (
    <div>
      <div className={s.toolbar}>
        <p className="t-cap">Uploads and fill-here W-9s waiting for a person. The AI read and every requirement check are shown beside the document. Accepting lifts the hold when nothing else is missing.</p>
        <div className={s.grow} />
        <Seg<View>
          aria-label="Open or decided"
          value={view}
          onChange={(v) => {
            setView(v);
            setSelectedId(null);
          }}
          items={[
            { value: 'open', label: 'Waiting', count: view === 'open' && data ? rows.length : undefined },
            { value: 'decided', label: 'Decided' },
          ]}
        />
      </div>

      {error ? (
        <div className={s.state} role="alert">
          <p className="t-head">Couldn’t load the review queue.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : isLoading && !data ? (
        <div className={s.state} role="status">
          <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
          <p className="t-cap">Loading the queue…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className={s.state}>
          <p className="t-head">{view === 'open' ? 'Nothing to review.' : 'Nothing decided yet.'}</p>
          <p className="ink-2">When a vendor uploads a W-9 or certificate (or fills in the W-9 online), it lands here with the AI read and the requirement checks.</p>
        </div>
      ) : (
        <>
          <QueueTable
            aria-label="Documents waiting for review"
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            rowState={(r) => ({ attn: r.status !== 'accepted' && r.status !== 'rejected' && r.rules_passed === false, done: r.status === 'accepted' })}
            cursorId={selectedId}
            onCursorChange={(id) => setSelectedId(id)}
            onOpen={(r) => setSelectedId(r.id)}
            openOnClick
            compact
          />
          {selected && <ReviewWorkspace key={selected.id} row={selected} onDone={() => { setSelectedId(null); void refetch(); onChanged(); }} />}
        </>
      )}
    </div>
  );
}

type DocLink = { url: string; fileName: string; mimeType: string | null };

function DocumentPreview({ submissionId, hasFile, isW9 }: { submissionId: string; hasFile: boolean; isW9: boolean }) {
  // A W-9 image shows the full TIN: it is opened only through a logged reveal (POST with a
  // reason) by a role allowed to reveal TINs — never fetched automatically.
  const { data: fetched, error, isLoading } = useQuery<DocLink>(hasFile && !isW9 ? '/api/vendor-compliance/review/document' : null, { submission_id: submissionId }, { scope: false });
  const [revealed, setRevealed] = useState<DocLink | null>(null);
  const [reason, setReason] = useState('');
  const [revealErr, setRevealErr] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  if (!hasFile) return <div className={s.state}><p className="t-head">Typed into the portal</p><p className="ink-2">No file — the vendor completed and e-signed the W-9 online. The fields are on the right.</p></div>;
  if (isW9 && !revealed) {
    const reveal = async () => {
      setRevealErr(null);
      setRevealing(true);
      const res = await api.post<DocLink>('/api/vendor-compliance/review/document', { submission_id: submissionId, reason: reason.trim() });
      setRevealing(false);
      if (res.error) return setRevealErr(res.error.error);
      if (res.data) setRevealed(res.data);
    };
    return (
      <div className={s.state}>
        <p className="t-head">This W-9 shows the full taxpayer ID</p>
        <p className="ink-2">Opening it is logged with your reason. Only roles allowed to reveal TINs can open it.</p>
        <Field label="Why are you opening it?">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reviewing the vendor’s W-9 submission" />
        </Field>
        {revealErr && <InlineNotice tone="neg" title="Can’t open it.">{revealErr}</InlineNotice>}
        <Button onClick={() => void reveal()} disabled={revealing || reason.trim().length < 3}>{revealing ? 'Opening…' : 'Open the W-9'}</Button>
      </div>
    );
  }
  const data = revealed ?? fetched;
  if (error) return <div className={s.state} role="alert"><p className="ink-2">{error}</p></div>;
  if (isLoading || !data) return <div className={s.state} role="status"><p className="t-cap">Loading the document…</p></div>;
  const isImage = (data.mimeType ?? '').startsWith('image/') || /\.(png|jpe?g)$/i.test(data.fileName);
  return (
    <div>
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={s.docImg} src={data.url} alt={`Submitted document ${data.fileName}`} />
      ) : (
        <iframe className={s.docFrame} src={data.url} title={`Submitted document ${data.fileName}`} />
      )}
      <p className="t-cap" style={{ marginTop: 4 }}>
        <a className="mb-nlink" href={data.url} target="_blank" rel="noreferrer">
          Open {data.fileName} in a new tab
        </a>{' '}
        · link valid 5 minutes
      </p>
    </div>
  );
}

function ReviewWorkspace({ row, onDone }: { row: QueueRow; onDone: () => void }) {
  const open = row.status === 'received' || row.status === 'ai_checked';
  const coi = row.extracted?.coi;
  const [lines, setLines] = useState<LineDraft[]>(() => (linesFrom(row).length ? linesFrom(row) : [{ coverage_type: 'GENERAL_LIABILITY', each: '', agg: '', effective: '', expiration: '' }]));
  const [holder, setHolder] = useState(coi?.certificate_holder ?? '');
  const [ai, setAi] = useState<boolean>(coi?.additional_insured === true);
  const [wos, setWos] = useState<boolean>(coi?.waiver_of_subrogation === true);
  const [apply1099, setApply1099] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const aiDown = row.ai_status === 'unavailable' || row.ai_status === 'failed';

  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const accept = async () => {
    setErr(null);
    const body: Record<string, unknown> = { action: 'accept', id: row.id };
    if (row.doc_kind === 'COI') {
      const coverages = [];
      for (const l of lines) {
        const each = dollarsToCentsInput(l.each);
        const agg = dollarsToCentsInput(l.agg);
        if (Number.isNaN(each) || Number.isNaN(agg)) return setErr('Limits are dollar amounts like 1000000 or 1,000,000.');
        coverages.push({ coverage_type: l.coverage_type, each_occurrence_cents: each, aggregate_cents: agg, effective_date: l.effective || null, expiration_date: l.expiration || null });
      }
      Object.assign(body, { coverages, certificate_holder: holder.trim() || null, additional_insured: ai, waiver_of_subrogation: wos });
    } else {
      body.apply_1099_signal = apply1099;
    }
    setBusy(true);
    const res = await api.post<ActionResponse>('/api/vendor-compliance/review', body);
    setBusy(false);
    if (res.error) return setErr(res.error.error);
    toast(res.data?.message ?? 'Accepted.');
    onDone();
  };

  const w9 = row.w9_form;
  const w9ai = row.extracted?.w9;
  const tinNotStored = row.doc_kind === 'W9' && row.source === 'portal_w9_form' && !!w9 && !w9.tin_stored;

  return (
    <section className={s.review} style={{ marginTop: 16 }} aria-label={`Review ${row.vendor_name}`}>
      <DocumentPreview submissionId={row.id} hasFile={!!row.document_id} isW9={row.doc_kind === 'W9'} />
      <div className="panel" style={{ padding: 16 }}>
        <div className="row row--between">
          <div>
            <div className="eyebrow">{row.doc_kind === 'W9' ? 'Form W-9' : 'Certificate of insurance'}</div>
            <div className="t-head">{row.vendor_name}</div>
            <div className="t-cap">Received {row.created_at.slice(0, 10)} · {AI_WORD[row.ai_status] ?? row.ai_status}</div>
          </div>
          {!open && <Tag tone={row.status === 'accepted' ? 'pos' : 'neg'}>{row.status === 'accepted' ? 'Accepted' : 'Rejected'}</Tag>}
        </div>

        {aiDown && open && (
          <div style={{ marginTop: 12 }}>
            <AiPaused>The AI couldn’t read this one ({row.ai_note ?? 'paused'}). Key the coverage lines from the document, then accept.</AiPaused>
          </div>
        )}
        {row.decision_reason && <InlineNotice tone={row.status === 'rejected' ? 'neg' : 'default'} title="Reviewer note">{row.decision_reason}</InlineNotice>}

        {(row.rule_results ?? []).length > 0 && (
          <>
            <h3 className="eyebrow" style={{ marginTop: 16 }}>Requirement checks</h3>
            <ul className={s.checks}>
              {row.rule_results.map((r) => {
                const o = outcomeLook(r.outcome);
                return (
                  <li key={r.rule}>
                    <span className="mb-sev"><Pip kind={o.pip} />{o.word}</span>
                    <span><span className="t-ui">{r.label}</span><span className="t-cap" style={{ display: 'block' }}>{r.reason}</span></span>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {row.doc_kind === 'W9' ? (
          <>
            <h3 className="eyebrow" style={{ marginTop: 16 }}>What the W-9 says</h3>
            {w9 ? (
              <KV
                items={[
                  { term: 'Legal name', value: w9.legal_name },
                  { term: 'Business name', value: w9.business_name ?? '—' },
                  { term: 'Tax classification', value: `${w9.entity_type.replace(/_/g, ' ').toLowerCase()}${w9.llc_tax_class ? ` (taxed as ${w9.llc_tax_class})` : ''}` },
                  { term: 'Address', value: [w9.address_line1, w9.address_line2, `${w9.city}, ${w9.state} ${w9.zip}`].filter(Boolean).join(', ') },
                  { term: w9.tin_type, value: <span className="tnum">ending {w9.tin_last4}{w9.tin_stored ? '' : ' (not retained)'}</span> },
                  { term: 'Signed', value: `${w9.signer_name}, ${w9.signed_at.slice(0, 10)}` },
                ]}
              />
            ) : w9ai ? (
              <KV
                items={[
                  { term: 'Legal name', value: w9ai.legal_name ?? '—' },
                  { term: 'Entity', value: w9ai.entity_type },
                  { term: 'TIN', value: <span className="tnum">{w9ai.tin_masked ?? '—'}</span> },
                ]}
              />
            ) : (
              <p className="ink-2">Read the W-9 in the document: the legal name, classification, TIN and signature must all be present.</p>
            )}
            {open && <Check label="Update the vendor’s 1099 eligibility from the tax classification" checked={apply1099} onChange={(e) => setApply1099(e.target.checked)} />}
          </>
        ) : (
          <>
            <h3 className="eyebrow" style={{ marginTop: 16 }}>Coverage lines {coi ? '(as read — correct anything that’s wrong)' : ''}</h3>
            {lines.map((l, i) => (
              <div key={i} className={s.lineRow}>
                <Field label="Coverage">
                  <Select value={l.coverage_type} onChange={(e) => setLine(i, { coverage_type: e.target.value })} disabled={!open}>
                    {COVERAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                </Field>
                <Field label="Each occurrence $"><Input inputMode="decimal" className="tnum" value={l.each} onChange={(e) => setLine(i, { each: e.target.value })} disabled={!open} /></Field>
                <Field label="Aggregate $"><Input inputMode="decimal" className="tnum" value={l.agg} onChange={(e) => setLine(i, { agg: e.target.value })} disabled={!open} /></Field>
                <Field label="Effective"><Input type="date" value={l.effective} onChange={(e) => setLine(i, { effective: e.target.value })} disabled={!open} /></Field>
                <Field label="Expires"><Input type="date" value={l.expiration} onChange={(e) => setLine(i, { expiration: e.target.value })} disabled={!open} /></Field>
                {open && <Button variant="quiet" iconOnly icon="x" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} />}
              </div>
            ))}
            {open && (
              <Button variant="quiet" icon="plus" onClick={() => setLines((ls) => [...ls, { coverage_type: 'WORKERS_COMP', each: '', agg: '', effective: '', expiration: '' }])} style={{ marginTop: 8 }}>
                Add a line
              </Button>
            )}
            <div className={s.formGrid} style={{ marginTop: 12 }}>
              <Field label="Certificate holder (as printed)"><Input value={holder} onChange={(e) => setHolder(e.target.value)} disabled={!open} /></Field>
              <Check label="Certificate holder is additional insured" checked={ai} onChange={(e) => setAi(e.target.checked)} disabled={!open} />
              <Check label="Waiver of subrogation shown" checked={wos} onChange={(e) => setWos(e.target.checked)} disabled={!open} />
            </div>
          </>
        )}

        {tinNotStored && (
          <InlineNotice tone="neg" title="The full taxpayer ID wasn’t saved.">
            TIN encryption wasn’t set up when the vendor filled this in, so only the last four digits were kept — not enough for 1099s. Set up TIN encryption, then reject this one and ask the vendor to fill in the W-9 again (or upload a signed W-9 PDF).
          </InlineNotice>
        )}
        {err && <InlineNotice tone="neg" title="Can’t accept yet.">{err}</InlineNotice>}
        {open && (
          <div className={s.actions} style={{ marginTop: 16 }}>
            <Button variant="primary" chord="a" onClick={() => void accept()} disabled={busy || tinNotStored}>
              {busy ? 'Accepting…' : 'Accept'}
            </Button>
            <Button chord="x" onClick={() => setRejectOpen(true)} disabled={busy}>
              Reject with reason
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title={`Reject this ${row.doc_kind === 'W9' ? 'W-9' : 'certificate'}?`}
        confirmLabel="Reject and re-request"
        tone="danger"
        reason={{ label: 'What’s wrong? (the vendor sees this)', minLength: 3, placeholder: 'Certificate holder must read Artistry Homes LLC, 4100 Westown Pkwy' }}
        onConfirm={async (reason) => {
          const res = await api.post<ActionResponse>('/api/vendor-compliance/review', { action: 'reject', id: row.id, reason: reason ?? '' });
          setRejectOpen(false);
          if (res.error) {
            toast.error(res.error.error);
            return;
          }
          toast(res.data?.message ?? 'Rejected.');
          onDone();
        }}
      >
        A correction request quoting your reason goes to the vendor on the usual reminder schedule.
      </ConfirmDialog>
    </section>
  );
}
